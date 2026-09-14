import { randomUUID } from "node:crypto";
import type { WorkspaceState } from "../../../../common/src/contracts/api.js";
import type {
  ConversationInput,
  InputContext,
} from "../../../../common/src/contracts/plugins.js";
import { id, text } from "../../../../common/src/contracts/protocol.js";
import type { Repository } from "../../ports/repository.js";
import type { InputRouter } from "../../processing/routing/input.js";
import { Tasks } from "../../processing/tasks/service.js";
export class Workspace {
  constructor(
    readonly store: Repository,
    readonly tasks: Tasks,
    readonly router: InputRouter,
    readonly flush: () => void,
    readonly artifact: (taskId: string) => Promise<unknown>,
    readonly preview: (taskId: string, userId: string) => string,
  ) {}
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
        meetings:
          this.store.list<WorkspaceState["meetings"][number]>("meeting"),
        tasks: this.store.list<WorkspaceState["tasks"][number]>("task"),
      } satisfies WorkspaceState;
    if (operation === "artifact") return this.artifact(id(input.taskId));
    if (operation === "preview")
      return { url: this.preview(id(input.taskId), user.id) };
    if (user.role === "viewer") throw new Error("PERMISSION_DENIED");
    switch (operation) {
      case "projects": {
        if (user.role !== "admin") throw new Error("PERMISSION_DENIED");
        const project = {
          id: randomUUID(),
          name: text(input.name, 100),
          remote:
            typeof input.remote === "string" ? input.remote.slice(0, 2000) : "",
        };
        this.store.put("project", project.id, project);
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
        const event: ConversationInput = {
          eventId: id(input.requestId ?? randomUUID()),
          meetingId: id(input.meetingId),
          text: text(input.text),
        };
        const meeting = this.store.get<{ projectId?: string }>(
          "meeting",
          event.meetingId,
        );
        if (!meeting) throw new Error("MEETING_NOT_FOUND");
        event.projectId = meeting.projectId;
        // Processing continues independently of the HTTP response and remains fenced by the session and plugin generation.
        void this.router.handle(event, context).catch((error) =>
          this.store.logError(error, {
            source: context.pluginId,
            operation: "input.process",
            eventId: event.eventId,
          }),
        );
        return { ok: true };
      }
      case "tasks": {
        const task = this.tasks.createTask({
          projectId: id(input.projectId),
          meetingId: id(input.meetingId),
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
