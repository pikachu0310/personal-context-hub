import { Implementations } from "../../processing/tasks/implementations.js";
import { executionSlots } from "@ido/common/contracts/work";
import { TaskDetails } from "../../processing/tasks/details.js";
import { supportsTask } from "../../clients/scheduler.js";
import { projectDiscussion } from "../../processing/tasks/board.js";
import { attachTaskSource } from "@ido/common/contracts/protocol";
import { shareLocalTask } from "../../processing/tasks/local-sharing.js";
import { WorkspaceLifecycle } from "../../processing/projects/lifecycle.js";
import { taskParticipants } from "../../processing/projects/task-participants.js";
import { deviceIdentity } from "../../clients/identity.js";
import { ProjectTeam } from "../../processing/projects/team.js";
import { Projects } from "../../processing/projects/service.js";
import { randomUUID, verify } from "node:crypto";
import { WebSocket } from "ws";
import {
  frame,
  id,
  text,
  type Command,
  type Grant,
  type Task,
} from "@ido/common/contracts/protocol";
import { secret } from "@ido/common/runtime/platform";
import {
  requiresPolicySupport,
  restrictExecutionPolicy,
} from "@ido/common/contracts/work";
import { Scheduler } from "../../clients/scheduler.js";
import type { Device } from "../../domain/models.js";
import type { Repository } from "../../ports/repository.js";
import { Tasks } from "../../processing/tasks/service.js";
import { createWorkPort } from "../../processing/tasks/work.js";
import { PreviewRelay } from "./preview.js";
import { taskSnapshot } from "./task-list.js";
import { MeetingKnowledgeStore } from "../../processing/minutes/knowledge.js";
import { transcriptPage } from "../../processing/minutes/transcript.js";
import { BoardInputError, TaskBoard } from "../../processing/tasks/board.js";
export class ClientConnections {
  meetingInput?: (
    device: Device,
    operation: string,
    input: Record<string, unknown>,
    valid: () => boolean,
  ) => Promise<unknown>;
  private detailService?: TaskDetails;
  get details() {
    return (this.detailService ??= new TaskDetails(this.store));
  }
  readonly peers = new Map<string, WebSocket>();
  readonly ready = new Set<string>();
  readonly sessions = new Map<
    string,
    {
      generation: number;
      connectedAt: number;
      lastSeenAt: number;
      disconnecting: boolean;
    }
  >();
  readonly disconnects = new Map<
    string,
    Promise<{ disconnected: boolean; unconfirmedTaskIds: string[] }>
  >();

  disconnect(
    deviceId: string,
    generation: number,
    actor: string,
    expected: Array<{
      id: string;
      runId: string;
      revision: number;
      controlVersion: number;
    }>,
  ) {
    const key = `${deviceId}:${generation}`;
    const previous = this.disconnects.get(key);
    if (previous) return previous;
    const socket = this.peers.get(deviceId),
      session = this.sessions.get(deviceId);
    if (!socket || !session || session.generation !== generation)
      throw new Error("CONNECTION_CHANGED");
    const tasks = this.store
      .list<Task>("task")
      .filter(
        (t) =>
          t.clientId === deviceId &&
          ["assigned", "running", "interrupted"].includes(t.state),
      );
    if (
      tasks.length !== expected.length ||
      tasks.some(
        (t) =>
          !expected.some(
            (e) =>
              e.id === t.id &&
              e.runId === t.runId &&
              e.revision === t.revision &&
              e.controlVersion === (t.controlVersion ?? 0),
          ),
      )
    )
      throw new Error("CONNECTION_TASKS_CHANGED");
    // No await between validation and fencing this exact connection from scheduling.
    session.disconnecting = true;
    this.ready.delete(deviceId);
    const receipts = tasks.map((t) =>
      this.tasks.control(t.id, actor, "stop", undefined, {
        requestKey: `disconnect:${deviceId}:${generation}:${t.id}`,
        expectedRevision: t.revision,
        expectedControlVersion: t.controlVersion ?? 0,
      }),
    );
    this.store.audit(actor, "connection.disconnect.requested", deviceId);
    // Do not replay an old execute/retry ahead of its stop after reconnecting.
    for (const command of this.store.pending(deviceId))
      if (
        ["execute", "retry"].includes(command.type) &&
        tasks.some(
          (t) =>
            t.id === command.taskId &&
            t.runId === command.runId &&
            (!command.revision || command.revision === t.revision),
        )
      )
        this.store.ack(deviceId, command.id!);
    const ids = new Set(receipts.map((r) => r.id));
    for (const command of this.store.pending(deviceId))
      if (
        command.type === "stop" &&
        ids.has(String(command.receiptId)) &&
        socket.readyState === WebSocket.OPEN
      )
        socket.send(JSON.stringify({ ...command, generation }));
    const operation = (async () => {
      const unconfirmed = () =>
        tasks
          .filter((t) => {
            const receipt = receipts.find((r) => r.taskId === t.id)!;
            return (
              this.store.get<Task>("task", t.id)?.controlReceipts?.[receipt.id]
                ?.delivery !== "stopped"
            );
          })
          .map((t) => t.id);
      const deadline = Date.now() + 3000;
      while (
        unconfirmed().length &&
        Date.now() < deadline &&
        socket.readyState === WebSocket.OPEN &&
        this.peers.get(deviceId) === socket
      )
        await new Promise((r) => setTimeout(r, 50));
      // Never close or remove a replacement connection.
      if (this.peers.get(deviceId) === socket) {
        this.peers.delete(deviceId);
        this.ready.delete(deviceId);
        this.sessions.delete(deviceId);
        this.preview.disconnected(deviceId);
      }
      const unknown = unconfirmed();
      socket.close(4004, "disconnected by administrator");
      const force = setTimeout(() => socket.terminate(), 1000);
      force.unref();
      socket.once("close", () => clearTimeout(force));
      this.store.audit(
        actor,
        unknown.length
          ? "connection.disconnected.stop_unconfirmed"
          : "connection.disconnected",
        deviceId,
      );
      this.changed();
      return { disconnected: true, unconfirmedTaskIds: unknown };
    })();
    this.disconnects.set(key, operation);
    void operation
      .finally(() => {
        // Keep a small in-memory idempotency window without retaining private content.
        if (this.disconnects.size > 100)
          this.disconnects.delete(this.disconnects.keys().next().value!);
      })
      .catch(() => {});
    return operation;
  }
  readonly artifactRequests = new Map<
    string,
    {
      deviceId: string;
      runId: string;
      revision: number;
      resolve: (data: Command) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  onImplementationChanged?: (meetingId: string) => void;
  readonly preview: PreviewRelay;
  readonly scheduler: Scheduler;
  readonly tasks: Tasks;
  lifecycle: WorkspaceLifecycle;
  invalidateTask(task: Task) {
    this.detailService?.invalidate(task.id);
    this.preview.removeTask(task.id);
    for (const [id, request] of this.artifactRequests)
      if (request.runId === task.runId) {
        clearTimeout(request.timer);
        request.reject(new Error("TASK_DELETED"));
        this.artifactRequests.delete(id);
      }
  }
  broadcastProjects() {
    const team = new ProjectTeam(this.store);
    for (const [deviceId, ws] of this.peers) {
      const device = this.store.get<Device>("device", deviceId);
      if (device && !device.revoked && ws.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({
            v: 1,
            type: "projects.updated",
            generation: device.generation,
            projects: team.projects(deviceId),
            tasks: this.store
              .list<Task>("task")
              .filter((t) =>
                team.projects(deviceId).some((p) => p.id === t.projectId),
              )
              .slice(-500)
              .map((task) => ({
                ...task,
                participants: taskParticipants(this.store, task),
                canDelete: this.lifecycle.canDelete(
                  { deviceId, valid: () => true },
                  task,
                ),
              })),
          }),
        );
    }
  }
  constructor(
    readonly store: Repository,
    readonly changed: () => void,
    frameAncestors: () => string[] = () => [],
  ) {
    this.lifecycle = new WorkspaceLifecycle(store);
    this.scheduler = new Scheduler(store);
    this.tasks = new Tasks(store);
    this.preview = new PreviewRelay(
      store,
      (id) => (this.ready.has(id) ? this.peers.get(id) : undefined),
      frameAncestors,
    );
  }
  connect(ws: WebSocket) {
    const challenge = secret();
    let deviceId: string | undefined,
      generation = 0;
    let authenticated = false;
    let lastTaskListAt = 0;
    const timeout = setTimeout(
      () => ws.close(4001, "authentication timeout"),
      10000,
    );
    ws.send(JSON.stringify({ v: 1, type: "challenge", challenge }));
    ws.on("pong", () => {
      (ws as WebSocket & { alive?: boolean }).alive = true;
      if (deviceId && this.peers.get(deviceId) === ws) {
        const session = this.sessions.get(deviceId);
        if (session) session.lastSeenAt = Date.now();
      }
    });
    ws.on("error", () => {});
    ws.on("message", async (raw) => {
      try {
        const data = frame(raw.toString());
        if (!authenticated) {
          if (data.type !== "authenticate") throw new Error("AUTH_REQUIRED");
          const device = this.store.get<Device>("device", id(data.deviceId));
          if (
            !device ||
            device.revoked ||
            !verify(
              null,
              Buffer.from(`ido:1:${device.id}:${challenge}`),
              device.publicKey,
              Buffer.from(String(data.signature), "base64"),
            )
          )
            throw new Error("AUTH_FAILED");
          deviceId = device.id;
          device.generation++;
          device.taskBoardVersion = data.taskBoardVersion === 1 ? 1 : undefined;
          device.lifecycleVersion = data.lifecycleVersion === 1 ? 1 : undefined;
          generation = device.generation;
          this.store.put("device", device.id, device);
          this.peers.get(device.id)?.close(4000, "superseded");
          this.ready.delete(device.id);
          this.peers.set(device.id, ws);
          this.sessions.set(device.id, {
            generation,
            connectedAt: Date.now(),
            lastSeenAt: Date.now(),
            disconnecting: false,
          });
          new ProjectTeam(this.store).profile(device.id, data.profile);
          authenticated = true;
          clearTimeout(timeout);
          ws.send(
            JSON.stringify({
              v: 1,
              type: "authenticated",
              identityId: deviceIdentity(this.store, device),
              generation,
              controlVersion: 1,
              taskBoardVersion: 1,
              continuationVersion: 1,
              projectVersion: 1,
              projects: new ProjectTeam(this.store).projects(device.id),
              workspaceVersion: 1,
              taskOptionsVersion: 1,
              conversationVersion: 1,
              localSharingVersion: 1,
              taskListVersion: 1,
              taskDetailVersion: 1,
              implementationVersion: 1,
              lifecycleVersion: 1,
              deletions:
                device.lifecycleVersion === 1
                  ? this.store
                      .pending(device.id)
                      .filter((c) => c.type === "task.purge")
                  : [],
            }),
          );
          return;
        }
        const device = this.store.get<Device>("device", deviceId!);
        if (
          !device ||
          device.revoked ||
          device.generation !== generation ||
          data.generation !== generation ||
          this.peers.get(device.id) !== ws
        )
          throw new Error("STALE_CONNECTION");
        const session = this.sessions.get(device.id);
        if (session) session.lastSeenAt = Date.now();
        if (session?.disconnecting && !["result", "ack"].includes(data.type))
          return;
        if (data.type === "board.request") {
          const requestId = id(data.requestId);
          const response = {
            v: 1,
            type: "board.result",
            generation,
            requestId,
            taskId: data.taskId,
            runId: data.runId,
            revision: data.revision,
          };
          try {
            const task = this.store.get<Task>("task", id(data.taskId));
            if (
              !task ||
              task.clientId !== device.id ||
              task.runId !== data.runId ||
              task.revision !== data.revision ||
              !["assigned", "running"].includes(task.state)
            )
              throw new Error("TASK_NOT_RUNNING");
            new ProjectTeam(this.store).require(device.id, task.projectId);
            if (
              !task.localMirror &&
              !device.grants.some((grant) => grant.projectId === task.projectId)
            )
              throw new Error("PERMISSION_DENIED");
            if (
              !data.input ||
              typeof data.input !== "object" ||
              Array.isArray(data.input)
            )
              throw new Error("INVALID_BOARD_INPUT");
            const board = new TaskBoard(this.store),
              input = data.input as Record<string, unknown>;
            let result;
            if (data.operation === "read") result = board.read(task, input);
            else if (data.operation === "post") {
              result = board.post(
                task,
                input,
                `${task.runId}:${text(data.postKey, 600)}`,
              );
              const target =
                this.store.get<Task>("task", result.taskId) ??
                projectDiscussion(task.projectId);
              if (
                result.created &&
                !["completed", "failed", "cancelled"].includes(target.state)
              )
                this.notifyBoard(task);
            } else throw new Error("INVALID_BOARD_OPERATION");
            ws.send(JSON.stringify({ ...response, result }));
          } catch (error) {
            ws.send(
              JSON.stringify({
                ...response,
                error:
                  error instanceof BoardInputError
                    ? error.message
                    : "BOARD_REQUEST_REJECTED",
              }),
            );
          }
          return;
        }
        if (data.type === "project.create") {
          const requestId = id(data.requestId);
          try {
            let project = new Projects(this.store).create(
              data.name,
              `${device.id}:${device.userId}:${requestId}`,
            );
            project = new ProjectTeam(this.store).own(device.id, project.id);
            ws.send(
              JSON.stringify({
                v: 1,
                type: "project.result",
                generation,
                requestId,
                project,
              }),
            );
            this.broadcastProjects();
          } catch (error) {
            const code =
              error instanceof Error &&
              [
                "PERMISSION_DENIED",
                "PROJECT_NAME_EXISTS",
                "PROJECT_REQUEST_MISMATCH",
                "INVALID_TEXT",
              ].includes(error.message)
                ? error.message
                : "PROJECT_CREATE_FAILED";
            ws.send(
              JSON.stringify({
                v: 1,
                type: "project.result",
                generation,
                requestId,
                error: code,
              }),
            );
          }
          return;
        }
        if (data.type === "workspace.request") {
          const requestId = id(data.requestId),
            input = (data.input ?? {}) as Record<string, unknown>,
            team = new ProjectTeam(this.store);
          try {
            let result: unknown;
            const actor = {
              deviceId: device.id,
              valid: () =>
                this.peers.get(device.id) === ws &&
                this.store.get<Device>("device", device.id)?.generation ===
                  generation,
            };
            switch (data.operation) {
              case "implementations.sync": {
                result = new Implementations(this.store).sync(device.id, input);
                const update = result as {
                  changed: boolean;
                  meetingId: string;
                };
                if (update.changed)
                  this.onImplementationChanged?.(update.meetingId);
                break;
              }
              case "implementations.list": {
                const projectId = id(input.projectId);
                team.require(device.id, projectId);
                result = new Implementations(this.store).choices(projectId);
                break;
              }
              case "implementations.read":
                result = new Implementations(this.store).read(device.id, input);
                break;

              case "task.detail.target": {
                const task = this.details.task(device.id, String(input.taskId));
                if (
                  task.clientId !== device.id ||
                  task.runId !== input.runId ||
                  task.revision !== input.revision
                )
                  throw new Error("TASK_ASSIGNMENT_CHANGED");
                const saved = this.store.get<{
                  snapshot: { sequence: number; revision: number };
                }>("task-detail", task.id);
                result = {
                  sequence:
                    saved?.snapshot.revision === task.revision
                      ? saved.snapshot.sequence
                      : 0,
                };
                break;
              }
              case "task.detail.sync":
                result = this.details.sync(device.id, generation, input);
                break;
              case "task.detail.read":
                result = this.details.read(device.id, input, this.peers);
                break;
              case "task.detail.refresh": {
                const task = this.details.task(device.id, String(input.taskId));
                const owner = task.clientId && this.peers.get(task.clientId);
                if (owner)
                  owner.send(
                    JSON.stringify({
                      v: 1,
                      type: "task.detail.refresh",
                      generation: this.store.get<Device>(
                        "device",
                        task.clientId!,
                      )?.generation,
                      taskId: task.id,
                      runId: task.runId,
                      revision: task.revision,
                    }),
                  );
                result = { requested: !!owner };
                break;
              }
              case "project.leave":
                result = team.leave(
                  device.id,
                  id(input.projectId),
                  input.membershipVersion,
                );
                break;
              case "project.transfer-owner":
                result = team.transfer(
                  device.id,
                  id(input.projectId),
                  id(input.deviceId),
                  input.membershipVersion,
                );
                break;
              case "task.join":
              case "task.leave":
                result = this.lifecycle.membership(
                  actor,
                  id(input.taskId),
                  data.operation === "task.join",
                  input.membershipVersion,
                );
                break;
              case "task.delete":
                result = await this.lifecycle.deleteTask(
                  actor,
                  id(input.taskId),
                  input,
                );
                this.flush();
                this.changed();
                break;
              case "profile":
                result = team.profile(device.id, input);
                break;
              case "project.invite":
                result = team.invite(device.id, id(input.projectId));
                break;
              case "project.inspect-invite":
                result = team.invitation(text(input.token, 200));
                break;
              case "project.join":
                result = team.joinInvitation(device.id, text(input.token, 200));
                break;
              case "project.remove-member":
                result = team.remove(
                  device.id,
                  id(input.projectId),
                  id(input.deviceId),
                );
                break;
              case "project.rename":
                result = team.rename(
                  device.id,
                  id(input.projectId),
                  input.name,
                );
                break;
              case "project.minutes.update":
                result = team.updateMinutes(device.id, input);
                break;
              case "project.transcript": {
                const projectId = id(input.projectId);
                team.require(device.id, projectId);
                result = transcriptPage(this.store, projectId, input);
                break;
              }
              case "project.snapshot":
                result = team.snapshot(device.id, id(input.projectId));
                break;
              case "project.knowledge": {
                const projectId = id(input.projectId);
                team.require(device.id, projectId);
                result = new MeetingKnowledgeStore(this.store).search(
                  projectId,
                  input,
                );
                break;
              }
              case "task.knowledge": {
                const task = this.store.get<Task>("task", id(input.taskId));
                if (!task) throw new Error("TASK_NOT_FOUND");
                team.require(device.id, task.projectId);
                if (
                  task.clientId !== device.id ||
                  task.runId !== input.runId ||
                  task.revision !== input.revision
                )
                  throw new Error("TASK_ASSIGNMENT_CHANGED");
                result = new MeetingKnowledgeStore(this.store).search(
                  task.projectId,
                  input,
                );
                break;
              }
              case "task.sources": {
                const task = this.store.get<Task>("task", id(input.taskId));
                if (!task) throw new Error("TASK_NOT_FOUND");
                team.require(device.id, task.projectId);
                if (input.sourceId) {
                  task.attachedSources = attachTaskSource(
                    task.attachedSources,
                    input,
                  );
                  this.store.put("task", task.id, task);
                  this.changed();
                }
                result = { sources: task.attachedSources ?? [] };
                break;
              }
              case "project.meeting.input":
              case "project.meeting.read": {
                if (!this.meetingInput)
                  throw new Error("MEETING_INPUT_UNSUPPORTED");
                result = await this.meetingInput(
                  device,
                  String(data.operation),
                  input,
                  () =>
                    this.peers.get(device.id) === ws &&
                    ws.readyState === WebSocket.OPEN,
                );
                break;
              }
              case "task.conversation":
              case "project.conversation": {
                const task =
                  data.operation === "project.conversation"
                    ? projectDiscussion(id(input.projectId))
                    : this.store.get<Task>("task", id(input.taskId));
                if (!task) throw new Error("TASK_NOT_FOUND");
                team.require(device.id, task.projectId);
                const board = new TaskBoard(this.store);
                if (input.text !== undefined) {
                  board.post(
                    task,
                    { body: text(input.text, 16000) },
                    `app:${device.id}:${id(input.requestId)}`,
                    device.profile?.name ?? device.name,
                    "app",
                  );
                  this.notifyBoard(task, true);
                }
                const page = board.read(task, {
                  taskId: task.id,
                  limit: 10,
                  ...(input.postId !== undefined
                    ? { id: input.postId, offset: input.offset }
                    : {}),
                  ...(input.before !== undefined
                    ? { before: input.before }
                    : {}),
                });
                result = page;
                break;
              }
              case "task.access-reset": {
                const task = this.store.get<Task>("task", id(input.taskId));
                if (!task) throw new Error("TASK_NOT_FOUND");
                team.require(device.id, task.projectId);
                if (
                  task.clientId !== device.id ||
                  task.revision !== input.revision ||
                  !["completed", "failed", "cancelled"].includes(task.state)
                )
                  throw new Error("STOP_BEFORE_ACCESS_CHANGE");
                task.effectiveExecutionPolicy = task.executionPolicy;
                this.store.put("task", task.id, task);
                this.store.audit(device.id, "task.access-reset", task.id);
                result = { ok: true };
                break;
              }
              case "task.control": {
                const task = this.store.get<Task>("task", id(input.taskId));
                if (!task) throw new Error("TASK_NOT_FOUND");
                team.require(device.id, task.projectId);
                if (input.operation !== "stop" && input.operation !== "steer")
                  throw new Error("INVALID_CONTROL");
                if (
                  !Number.isSafeInteger(input.revision) ||
                  Number(input.revision) < 1
                )
                  throw new Error("INVALID_REVISION");
                result = this.tasks.control(
                  task.id,
                  `client-${device.id}`,
                  input.operation,
                  input.operation === "steer"
                    ? text(input.text, 8000)
                    : undefined,
                  {
                    requestKey: `client:${device.id}:control:${id(input.requestId)}`,
                    expectedRevision: Number(input.revision),
                  },
                );
                this.flush();
                this.changed();
                break;
              }
              case "task.continue": {
                const task = this.store.get<Task>("task", id(input.taskId));
                if (!task) throw new Error("TASK_NOT_FOUND");
                team.require(device.id, task.projectId);
                if (!task.clientId) throw new Error("TASK_NOT_ASSIGNED");
                team.require(task.clientId, task.projectId);
                if (
                  !Number.isSafeInteger(input.revision) ||
                  Number(input.revision) < 1
                )
                  throw new Error("INVALID_REVISION");
                result = this.tasks.control(
                  task.id,
                  `client-${device.id}`,
                  "retry",
                  undefined,
                  {
                    requestKey: `client:${device.id}:continue:${id(input.requestId)}`,
                    continuation: text(input.text, 8000),
                    expectedRevision: Number(input.revision),
                  },
                );
                this.flush();
                this.changed();
                break;
              }
              case "task.share-local": {
                result = shareLocalTask(
                  this.store,
                  device.id,
                  generation,
                  input,
                );
                this.flush();
                this.changed();
                break;
              }
              case "task.create": {
                const agent = input.agent;
                if (
                  agent !== undefined &&
                  agent !== "codex" &&
                  agent !== "claude"
                )
                  throw new Error("INVALID_AGENT");
                if (
                  input.progressMode !== undefined &&
                  input.progressMode !== "auto" &&
                  input.progressMode !== "manual"
                )
                  throw new Error("INVALID_PROGRESS_MODE");
                const selected = (value: unknown) => {
                  if (value === undefined || value === "") return undefined;
                  if (
                    typeof value !== "string" ||
                    !/^[A-Za-z0-9][A-Za-z0-9._:/\[\]-]{0,159}$/.test(value)
                  )
                    throw new Error("INVALID_MODEL");
                  return value;
                };
                const projectId = id(input.projectId);
                team.require(device.id, projectId);
                const routed = new Projects(this.store).accept(
                  {
                    eventId: id(input.requestId),
                    projectId,
                    text: text(input.text),
                  },
                  `client:${device.id}`,
                );
                result = this.tasks.createTask({
                  projectId,
                  meetingId: routed.meetingId,
                  authorId: `client-${device.id}`,
                  text: text(input.text),
                  requestId: id(input.requestId),
                  network: false,
                  agent,
                  model: selected(input.model),
                  reasoningEffort: selected(input.reasoningEffort),
                  progressMode: input.progressMode as
                    "auto" | "manual" | undefined,
                });
                this.flush();
                this.changed();
                break;
              }
              default:
                throw new Error("UNKNOWN_OPERATION");
            }
            ws.send(
              JSON.stringify({
                v: 1,
                type: "workspace.result",
                generation,
                requestId,
                result,
              }),
            );
            if (
              ![
                "implementations.sync",
                "implementations.list",
                "implementations.read",
                "task.detail.target",
                "task.detail.sync",
                "task.detail.read",
                "task.detail.refresh",
                "project.snapshot",
                "project.knowledge",
                "project.transcript",
                "task.knowledge",
                "task.conversation",
                "project.conversation",
                "project.meeting.read",
                "project.inspect-invite",
              ].includes(String(data.operation))
            )
              this.broadcastProjects();
          } catch (error) {
            const reason = (error as Error).message;
            ws.send(
              JSON.stringify({
                v: 1,
                type: "workspace.result",
                generation,
                requestId,
                error: /^[A-Z_]+$/.test(reason)
                  ? reason
                  : "WORKSPACE_REQUEST_FAILED",
              }),
            );
          }
          return;
        }
        if (data.type === "tasks.list") {
          const projectIds = new Set(
            new ProjectTeam(this.store).projects(device.id).map((p) => p.id),
          );
          if (Date.now() - lastTaskListAt < 2000) return;
          lastTaskListAt = Date.now();
          ws.send(
            JSON.stringify({
              v: 1,
              type: "tasks.snapshot",
              generation,
              snapshot: taskSnapshot(this.store, this.peers, projectIds),
            }),
          );
          return;
        }
        if (data.type === "artifact.result") {
          const pending = this.artifactRequests.get(String(data.requestId));
          if (
            pending &&
            pending.deviceId === device.id &&
            pending.runId === data.runId &&
            pending.revision === data.revision
          ) {
            clearTimeout(pending.timer);
            this.artifactRequests.delete(String(data.requestId));
            pending.resolve(data);
          }
          return;
        }
        if (data.type === "work.control") {
          const requestKey = id(data.requestKey);
          try {
            const task = this.store.get<Task>("task", id(data.taskId));
            if (
              !task ||
              task.clientId !== device.id ||
              task.runId !== data.runId ||
              task.revision !== data.revision
            )
              throw new Error("TASK_NOT_OWNED_BY_DEVICE");
            new ProjectTeam(this.store).require(device.id, task.projectId);
            const receipt = createWorkPort({
              repository: this.store,
              tasks: this.tasks,
            }).control({
              taskId: task.id,
              authorId: `client-${device.id}`,
              type: "instruction",
              instruction: text(data.instruction, 8000),
              requestKey: `client:${device.id}:${requestKey}`,
            });
            ws.send(
              JSON.stringify({
                v: 1,
                type: "work.control.result",
                generation,
                requestKey,
                receipt,
              }),
            );
            this.flush();
            this.changed();
          } catch (error) {
            const allowed = [
              "PERMISSION_DENIED",
              "TASK_NOT_OWNED_BY_DEVICE",
              "TASK_NOT_RUNNING",
              "WORKER_POLICY_UNSUPPORTED",
              "INVALID_TEXT",
            ];
            const reason = (error as Error).message;
            ws.send(
              JSON.stringify({
                v: 1,
                type: "work.control.result",
                generation,
                requestKey,
                error: allowed.includes(reason) ? reason : "CONTROL_REJECTED",
              }),
            );
          }
          return;
        }
        if (data.type.startsWith("preview.")) {
          if (data.type === "preview.register")
            this.preview.register(device.id, data);
          else this.preview.receive(device.id, data);
          return;
        }
        if (data.type === "ready") {
          if (!Array.isArray(data.grants) || data.grants.length > 100)
            throw new Error("INVALID_GRANTS");
          if (data.profile) {
            device.profile = new ProjectTeam(this.store).profile(
              device.id,
              data.profile,
            );
            device.name = device.profile.name;
          }
          device.codexConnected =
            (data.profile as { codexConnected?: boolean } | undefined)
              ?.codexConnected === true;
          device.grants = data.grants
            .map((g: Grant) => ({
              projectId: id(g.projectId),
              network: g.network === true,
              ...(Array.isArray(g.agents)
                ? {
                    agents: g.agents.filter(
                      (agent: string) =>
                        agent === "codex" || agent === "claude",
                    ),
                  }
                : {}),
              slots: executionSlots(g.slots, 1),
            }))
            .filter(
              (g) =>
                !!this.store.get(
                  "project-member",
                  `${g.projectId}:${device.id}`,
                ),
            );
          device.slots = executionSlots(data.slots, 1);
          device.executionPolicyVersion =
            data.executionPolicyVersion === 1 ? 1 : undefined;
          this.store.put("device", device.id, device);
          this.ready.add(device.id);
          this.flush();
          this.broadcastProjects();
        } else if (data.type === "ack")
          this.lifecycle.acknowledge(device.id, id(data.id));
        else if (data.type === "result") {
          this.tasks.updateResult(device.id, generation, data);
          this.flush();
          this.changed();
        }
      } catch {
        ws.close(4003, "invalid message");
      }
    });
    ws.once("close", () => {
      clearTimeout(timeout);
      if (deviceId && this.peers.get(deviceId) === ws) {
        this.peers.delete(deviceId);
        this.ready.delete(deviceId);
        this.sessions.delete(deviceId);
        this.preview.disconnected(deviceId);
      }
    });
  }
  private notifyBoard(author: Task, includeAuthor = false) {
    for (const task of this.store.list<Task>("task")) {
      if (
        (!includeAuthor && task.id === author.id) ||
        task.projectId !== author.projectId ||
        !task.clientId ||
        !["assigned", "running"].includes(task.state)
      )
        continue;
      const device = this.store.get<Device>("device", task.clientId);
      const socket = this.peers.get(task.clientId);
      if (
        !device ||
        device.revoked ||
        device.taskBoardVersion !== 1 ||
        !this.ready.has(device.id) ||
        socket?.readyState !== WebSocket.OPEN ||
        (!task.localMirror &&
          !device.grants.some((grant) => grant.projectId === task.projectId))
      )
        continue;
      try {
        new ProjectTeam(this.store).require(device.id, task.projectId);
        socket.send(
          JSON.stringify({
            v: 1,
            type: "board.changed",
            generation: device.generation,
            taskId: task.id,
            runId: task.runId,
            revision: task.revision,
          }),
        );
      } catch {
        /* A notice cannot undo a saved post. */
      }
    }
  }
  flush() {
    this.scheduler.schedule(this.ready);
    for (const deviceId of this.ready) {
      const socket = this.peers.get(deviceId);
      const device = this.store.get<Device>("device", deviceId);
      if (socket?.readyState === WebSocket.OPEN && device)
        for (const command of this.store.pending(deviceId)) {
          if (command.type === "task.purge" && device.lifecycleVersion !== 1)
            continue;
          const task = command.task as Task | undefined;
          if (
            ["execute", "retry"].includes(command.type) &&
            task &&
            (!supportsTask(device, task) ||
              !this.store.get(
                "project-member",
                `${task.projectId}:${device.id}`,
              ))
          )
            continue;
          if (
            ["execute", "retry", "steer"].includes(command.type) &&
            task &&
            requiresPolicySupport(
              restrictExecutionPolicy(
                task.executionPolicy,
                task.effectiveExecutionPolicy,
              ),
            ) &&
            device.executionPolicyVersion !== 1
          )
            continue;
          socket.send(
            JSON.stringify({ ...command, generation: device.generation }),
          );
        }
    }
  }

  async artifact(taskId: string) {
    const task = this.store.get<Task>("task", taskId);
    const device =
      task?.clientId && this.store.get<Device>("device", task.clientId);
    const socket = task?.clientId && this.peers.get(task.clientId);
    if (!task || !device || !socket || !this.ready.has(device.id))
      throw new Error("CLIENT_OFFLINE");
    const requestId = randomUUID();
    return new Promise<Command>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.artifactRequests.delete(requestId);
        reject(new Error("ARTIFACT_TIMEOUT"));
      }, 15000);
      this.artifactRequests.set(requestId, {
        deviceId: device.id,
        runId: task.runId,
        revision: task.revision,
        resolve,
        reject,
        timer,
      });
      socket.send(
        JSON.stringify({
          v: 1,
          type: "artifact.request",
          requestId,
          taskId,
          runId: task.runId,
          revision: task.revision,
          generation: device.generation,
        }),
      );
    });
  }
  close() {
    for (const request of this.artifactRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("CLIENT_OFFLINE"));
    }
    this.artifactRequests.clear();
    for (const peer of this.peers.values()) peer.terminate();
    this.preview.close();
  }
}
