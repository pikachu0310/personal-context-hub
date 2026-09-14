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
export class ClientConnections {
  readonly peers = new Map<string, WebSocket>();
  readonly ready = new Set<string>();
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
  readonly preview: PreviewRelay;
  readonly scheduler: Scheduler;
  readonly tasks: Tasks;
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
              .slice(-500),
          }),
        );
    }
  }
  constructor(
    readonly store: Repository,
    readonly changed: () => void,
    frameAncestors: () => string[] = () => [],
  ) {
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
    const timeout = setTimeout(
      () => ws.close(4001, "authentication timeout"),
      10000,
    );
    ws.send(JSON.stringify({ v: 1, type: "challenge", challenge }));
    ws.on("pong", () => {
      (ws as WebSocket & { alive?: boolean }).alive = true;
    });
    ws.on("error", () => {});
    ws.on("message", (raw) => {
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
          generation = device.generation;
          this.store.put("device", device.id, device);
          this.peers.get(device.id)?.close(4000, "superseded");
          this.ready.delete(device.id);
          this.peers.set(device.id, ws);
          new ProjectTeam(this.store).profile(device.id, data.profile);
          authenticated = true;
          clearTimeout(timeout);
          ws.send(
            JSON.stringify({
              v: 1,
              type: "authenticated",
              generation,
              controlVersion: 1,
              projectVersion: 1,
              projects: new ProjectTeam(this.store).projects(device.id),
              workspaceVersion: 1,
            }),
          );
          return;
        }
        const device = this.store.get<Device>("device", deviceId!);
        if (
          !device ||
          device.revoked ||
          device.generation !== generation ||
          data.generation !== generation
        )
          throw new Error("STALE_CONNECTION");
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
            switch (data.operation) {
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
              case "project.snapshot":
                result = team.snapshot(device.id, id(input.projectId));
                break;
              case "task.create": {
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
              data.operation !== "project.snapshot" &&
              data.operation !== "project.inspect-invite"
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
              slots: Math.max(1, Math.min(8, Number(g.slots) || 1)),
            }))
            .filter(
              (g) =>
                !!this.store.get(
                  "project-member",
                  `${g.projectId}:${device.id}`,
                ),
            );
          device.slots = Math.max(1, Math.min(8, Number(data.slots) || 1));
          device.executionPolicyVersion =
            data.executionPolicyVersion === 1 ? 1 : undefined;
          this.store.put("device", device.id, device);
          this.ready.add(device.id);
          this.flush();
          this.broadcastProjects();
        } else if (data.type === "ack") this.store.ack(device.id, id(data.id));
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
        this.preview.disconnected(deviceId);
      }
    });
  }
  flush() {
    this.scheduler.schedule(this.ready);
    for (const deviceId of this.ready) {
      const socket = this.peers.get(deviceId);
      const device = this.store.get<Device>("device", deviceId);
      if (socket?.readyState === WebSocket.OPEN && device)
        for (const command of this.store.pending(deviceId)) {
          const task = command.task as Task | undefined;
          if (
            ["execute", "retry"].includes(command.type) &&
            task &&
            (!device.codexConnected ||
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
