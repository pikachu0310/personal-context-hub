import {
  WorkspaceLifecycle,
  type Deletion,
} from "../../processing/projects/lifecycle.js";
import { ProjectTeam } from "../../processing/projects/team.js";
import { randomUUID } from "node:crypto";
import type { WorkspaceState, MessageView } from "@ido/common/contracts/api";
import type {
  ConversationInput,
  InputContext,
} from "@ido/common/contracts/plugins";
import { id, text } from "@ido/common/contracts/protocol";
import type { Repository } from "../../ports/repository.js";
import type { InputRouter } from "../../processing/routing/input.js";
import { Tasks } from "../../processing/tasks/service.js";
import { Projects } from "../../processing/projects/service.js";
export class Workspace {
  lifecycle: WorkspaceLifecycle;
  engineUrl: () => string = () => "";
  constructor(
    readonly store: Repository,
    readonly tasks: Tasks,
    readonly router: InputRouter,
    readonly flush: () => void,
    readonly artifact: (taskId: string) => Promise<unknown>,
    readonly preview: (taskId: string, userId: string) => string,
  ) {
    this.lifecycle = new WorkspaceLifecycle(store);
  }
  private meetings(): WorkspaceState["meetings"] {
    const outputs = this.store.list<{
      id: string;
      meetingId: string;
      provider?: string;
      text?: string;
      sourceIds?: string[];
      at?: number;
      startedAt?: number;
    }>("conversation-output");
    return this.store
      .list<WorkspaceState["meetings"][number]>("meeting")
      .map((meeting) => {
        const messages: MessageView[] = meeting.messages.map((message) => ({
          ...message,
          authorName:
            message.authorName ??
            this.store.conversationAuthor(message.authorId)?.name,
          role: message.role ?? "user",
        }));
        for (const output of outputs
          .filter((output) => output.meetingId === meeting.id)
          .slice(-100)) {
          if (
            typeof output.text !== "string" ||
            !output.text.length ||
            messages.some((message) => message.id === output.id)
          )
            continue;
          // Direct answers already appear beneath their source message. Results
          // without a current source and Live transcripts need their own view row.
          if (
            (output.sourceIds ?? []).some((id) =>
              messages.some(
                (message) =>
                  message.id === id && message.replyText === output.text,
              ),
            )
          )
            continue;
          messages.push({
            id: output.id,
            authorId: `assistant:${output.provider ?? "coordinator"}`,
            authorName: output.provider === "live" ? "IDO (Live)" : "IDO",
            role: "assistant",
            text: output.text,
            at: output.at ?? output.startedAt ?? 0,
            stage: output.provider === "live" ? "transcript" : "generated",
          });
        }
        messages.sort((left, right) => left.at - right.at);
        return { ...meeting, messages };
      });
  }
  async request(
    operation: string,
    input: Record<string, unknown>,
    context: InputContext,
    activity = false,
  ) {
    const user = this.store.user(context.actor.id);
    if (!user || !context.valid()) throw new Error("LOGIN_REQUIRED");
    if (
      activity &&
      !["state", "messages", "task/control", "preview"].includes(operation)
    )
      throw new Error("PERMISSION_DENIED");
    if (operation === "state")
      return {
        user,
        projects:
          this.store.list<WorkspaceState["projects"][number]>("project"),
        conversations: this.store.list("project-conversation"),
        meetings: this.meetings(),
        tasks: this.store
          .list<WorkspaceState["tasks"][number]>("task")
          .map((task) => ({
            ...task,
            canDelete: this.lifecycle.canDelete(
              { user, valid: context.valid },
              task,
            ),
          })),
        deletionSync:
          user.role === "admin"
            ? {
                pendingClients: new Set(
                  this.store
                    .list<Deletion>("task-deletion")
                    .flatMap((d) => d.pendingDeviceIds),
                ).size,
              }
            : undefined,
      } satisfies WorkspaceState;
    if (operation === "artifact") return this.artifact(id(input.taskId));
    if (
      operation === "conversation/state" ||
      operation === "conversation/log"
    ) {
      const meetingId = id(input.meetingId);
      if (!this.store.get("meeting", meetingId))
        throw new Error("MEETING_NOT_FOUND");
      if (operation === "conversation/state")
        return this.router.ai.coordinated?.state(meetingId);
      return this.store
        .list<{ meetingId: string }>("conversation-output")
        .filter((value) => value.meetingId === meetingId)
        .slice(-100);
    }
    if (operation === "preview")
      return { url: this.preview(id(input.taskId), user.id) };
    if (user.role === "viewer") throw new Error("PERMISSION_DENIED");
    switch (operation) {
      case "project/invite": {
        if (context.pluginId !== "dashboard" || user.role !== "admin")
          throw new Error("PERMISSION_DENIED");
        const invite = new ProjectTeam(this.store).issueInvite(
          id(input.projectId),
        );
        return { url: `${this.engineUrl()}/invite/${invite.token}` };
      }
      case "project/delete": {
        if (context.pluginId !== "dashboard")
          throw new Error("PERMISSION_DENIED");
        const result = await this.lifecycle.deleteProject(
          { user, valid: context.valid },
          id(input.projectId),
          input,
        );
        this.flush();
        return result;
      }
      case "task/delete": {
        const result = await this.lifecycle.deleteTask(
          { user, valid: context.valid },
          id(input.taskId),
          input,
        );
        this.flush();
        return result;
      }
      case "conversation/control": {
        if (!this.router.ai.coordinated)
          throw new Error("COORDINATOR_UNAVAILABLE");
        const meetingId = id(input.meetingId);
        const run = (operation: Promise<unknown>) => {
          void operation.catch((error) =>
            this.store.logError(error, {
              source: "conversation",
              operation: "conversation.control",
              meetingId,
            }),
          );
          return { ok: true };
        };
        if (input.action === "flush")
          return run(this.router.ai.coordinated.flush(meetingId));
        if (
          input.batchId !== this.router.ai.coordinated.state(meetingId).batchId
        )
          throw new Error("COORDINATOR_VERSION_MISMATCH");
        if (
          input.action === "resume" &&
          Array.isArray(input.sourceIds) &&
          input.sourceIds.length <= 100
        ) {
          return run(
            this.router.ai.coordinated.resume(
              meetingId,
              context,
              input.sourceIds.map((value) => id(value)),
            ),
          );
        }
        if (input.action === "resolve" && typeof input.retry === "boolean") {
          return run(
            this.router.ai.coordinated.resolve(meetingId, input.retry),
          );
        }
        throw new Error("INVALID_ACTION");
      }
      case "projects": {
        const project = new Projects(this.store).create(
          input.name,
          `${user.id}:${id(input.requestId ?? randomUUID())}`,
          typeof input.remote === "string" ? input.remote.slice(0, 2000) : "",
        );
        this.flush();
        return project;
      }
      case "meetings": {
        const projectId = input.projectId ? id(input.projectId) : undefined;
        if (projectId && !this.store.get("project", projectId))
          throw new Error("PROJECT_NOT_FOUND");
        const meeting = {
          id: randomUUID(),
          name: text(input.name, 100),
          projectId,
          summary: "",
          messages: [],
        };
        this.store.put("meeting", meeting.id, meeting);
        return meeting;
      }
      case "messages": {
        if (
          input.priority !== undefined &&
          !["normal", "immediate"].includes(String(input.priority))
        )
          throw new Error("INVALID_INPUT_PRIORITY");
        const event: ConversationInput = {
          eventId: id(input.requestId ?? randomUUID()),
          meetingId: "",
          text: text(input.text),
          interaction: true,
          priority: input.priority === "normal" ? "normal" : "immediate",
        };
        const routed = new Projects(this.store).accept(
          {
            ...event,
            meetingId: input.meetingId ? id(input.meetingId) : undefined,
            projectId: input.projectId ? id(input.projectId) : undefined,
          },
          context.pluginId,
        );
        // Processing continues independently of the HTTP response and remains fenced by the session and plugin generation.
        void this.router.handle(routed, context).catch((error) =>
          this.store.logError(error, {
            source: context.pluginId,
            operation: "input.process",
            eventId: event.eventId,
          }),
        );
        return { ok: true };
      }
      case "tasks": {
        const routed = new Projects(this.store).accept(
          {
            eventId: id(input.requestId),
            projectId: input.projectId ? id(input.projectId) : undefined,
            meetingId: input.meetingId ? id(input.meetingId) : undefined,
            text: text(input.text),
          },
          context.pluginId,
        );
        const task = this.tasks.createTask({
          projectId: routed.projectId!,
          meetingId: routed.meetingId,
          authorId: user.id,
          text: text(input.text),
          requestId: id(input.requestId),
          network: input.network === true,
        });
        this.flush();
        return task;
      }
      case "task/control": {
        const action = String(input.action);
        if (
          !(activity ? ["stop", "steer"] : ["stop", "steer", "retry"]).includes(
            action,
          )
        )
          throw new Error("INVALID_ACTION");
        this.tasks.control(
          id(input.taskId),
          user.id,
          action as "stop" | "steer" | "retry",
          input.text ? text(input.text) : undefined,
        );
        this.flush();
        return { ok: true };
      }
      default:
        throw new Error("UNKNOWN_OPERATION");
    }
  }
}
