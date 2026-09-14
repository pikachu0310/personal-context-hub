import { ProjectTeam } from "../../processing/projects/team.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { id, type Task } from "@ido/common/contracts/protocol";
import { body, HttpError, send } from "@ido/common/runtime/http";
import type { Engine } from "../../bootstrap/engine.js";
import type { Auth } from "./auth.js";
import { dashboardSnapshot, dashboardRaw } from "./dashboard-query.js";

export async function dashboard(
  this: Engine,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  auth: Auth,
) {
  if (!url.pathname.startsWith("/api/admin/dashboard")) return false;
  if (auth.user.role !== "admin") throw new HttpError(403, "PERMISSION_DENIED");
  if (req.method === "GET" && url.pathname === "/api/admin/dashboard") {
    send(
      res,
      200,
      dashboardSnapshot(
        this,
        auth.user,
        url.searchParams.get("projectId") || undefined,
      ),
    );
  } else if (
    req.method === "GET" &&
    url.pathname === "/api/admin/dashboard/raw"
  ) {
    send(res, 200, dashboardRaw(this, url.searchParams));
  } else if (req.method === "POST") {
    this.mutate(req, auth, true);
    const input = await body(req);
    try {
      const actor = {
        user: auth.user,
        valid: () => {
          try {
            return this.authenticate(req).user.id === auth.user.id;
          } catch {
            return false;
          }
        },
      };
      if (url.pathname === "/api/admin/dashboard/project/invite") {
        const invitation = new ProjectTeam(this.store).issueInvite(
          id(input.projectId),
        );
        send(res, 200, {
          url: `${this.config().engineUrl ?? this.origin}/invite/${invitation.token}`,
        });
      } else if (url.pathname === "/api/admin/dashboard/project/delete") {
        const result = await this.connections.lifecycle.deleteProject(
          actor,
          id(input.projectId),
          input,
        );
        this.flush();
        send(res, 200, result);
      } else if (url.pathname === "/api/admin/dashboard/task/delete") {
        const result = await this.connections.lifecycle.deleteTask(
          actor,
          id(input.taskId),
          input,
        );
        this.flush();
        send(res, 200, result);
      } else if (url.pathname === "/api/admin/dashboard/stop") {
        const task = this.store.get<Task>("task", id(input.taskId));
        if (!task) throw new HttpError(404, "TASK_NOT_FOUND");
        if (
          !Number.isSafeInteger(input.revision) ||
          !Number.isSafeInteger(input.controlVersion) ||
          input.runId !== task.runId
        )
          throw new HttpError(409, "TASK_CONTROL_SUPERSEDED");
        const requestKey = `dashboard:${id(input.requestId)}`;
        const previous = Object.values(task.controlReceipts ?? {}).find(
          (r) => r.authorId === auth.user.id && r.requestKey === requestKey,
        );
        if (previous) {
          send(res, 200, previous);
          return true;
        }
        if (
          !["queued", "assigned", "running", "interrupted"].includes(task.state)
        )
          throw new HttpError(409, "TASK_ALREADY_FINISHED");
        const receipt = this.tasks.control(
          task.id,
          auth.user.id,
          "stop",
          undefined,
          {
            requestKey,
            expectedRevision: input.revision,
            expectedControlVersion: input.controlVersion,
          },
        );
        this.flush();
        send(res, 200, receipt);
      } else if (url.pathname === "/api/admin/dashboard/disconnect") {
        if (
          !Number.isSafeInteger(input.generation) ||
          !Array.isArray(input.tasks) ||
          input.tasks.length > 100 ||
          input.tasks.some(
            (t: any) =>
              !t ||
              typeof t.id !== "string" ||
              typeof t.runId !== "string" ||
              !Number.isSafeInteger(t.revision) ||
              !Number.isSafeInteger(t.controlVersion),
          )
        )
          throw new HttpError(400, "INVALID_CONNECTION_TARGET");
        const result = await this.connections.disconnect(
          id(input.deviceId),
          input.generation,
          auth.user.id,
          input.tasks,
        );
        send(res, 200, result);
      } else throw new HttpError(404, "NOT_FOUND");
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (
        [
          "WORKSPACE_CONFLICT",
          "TASK_ACTIVE",
          "PROJECT_TASKS_ACTIVE",
          "CONNECTION_CHANGED",
          "CONNECTION_TASKS_CHANGED",
          "TASK_CONTROL_SUPERSEDED",
        ].includes((error as Error).message)
      )
        throw new HttpError(409, (error as Error).message);
      throw error;
    }
  } else throw new HttpError(404, "NOT_FOUND");
  return true;
}
