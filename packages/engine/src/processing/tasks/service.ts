import { randomUUID } from "node:crypto";
import type {
  Command,
  Project,
  Task,
} from "../../../../common/src/contracts/protocol.js";
import type { Device } from "../../domain/models.js";
import type { Repository } from "../../ports/repository.js";
export class Tasks {
  constructor(readonly repository: Repository) {}
  createTask(
    input: Pick<
      Task,
      "projectId" | "meetingId" | "authorId" | "text" | "requestId" | "network"
    >,
  ): Task {
    if (!this.repository.get<Project>("project", input.projectId))
      throw new Error("PROJECT_NOT_FOUND");
    return this.repository.transaction(() => {
      const key = JSON.stringify([
        input.authorId,
        input.projectId,
        input.requestId,
      ]);
      const previous = this.repository.requestTask(key);
      if (previous) return this.repository.get<Task>("task", previous)!;
      const task: Task = {
        ...input,
        id: randomUUID(),
        runId: randomUUID(),
        revision: 1,
        state: "queued",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: [],
      };
      this.repository.put("task", task.id, task);
      this.repository.rememberRequest(key, task.id);
      this.repository.audit(input.authorId, "task.create", task.id);
      return task;
    });
  }
  updateResult(deviceId: string, generation: number, data: Command) {
    const device = this.repository.get<Device>("device", deviceId),
      task = this.repository.get<Task>("task", String(data.taskId));
    if (
      !device ||
      device.revoked ||
      generation !== device.generation ||
      !task ||
      task.clientId !== deviceId ||
      task.runId !== data.runId ||
      data.revision !== task.revision
    )
      return false;
    if (["completed", "failed", "cancelled"].includes(task.state)) return false;
    const next = data.state;
    if (
      !["running", "interrupted", "completed", "failed", "cancelled"].includes(
        String(next),
      )
    )
      return false;
    task.state = next as Task["state"];
    task.progress =
      typeof data.progress === "string"
        ? data.progress.slice(0, 16000)
        : task.progress;
    if (typeof data.result === "string")
      task.result = data.result.slice(0, 64000);
    task.updatedAt = Date.now();
    this.repository.put("task", task.id, task);
    return true;
  }
  control(
    taskId: string,
    actor: string,
    type: "steer" | "stop" | "retry",
    text?: string,
  ) {
    return this.repository.transaction(() => {
      const task = this.repository.get<Task>("task", taskId);
      if (!task) throw new Error("TASK_NOT_FOUND");
      if (type === "stop" && task.state === "queued") {
        task.state = "cancelled";
        task.updatedAt = Date.now();
        this.repository.put("task", task.id, task);
        this.repository.audit(actor, "task.stop", taskId);
        return;
      }
      if (type === "steer" && task.state === "queued") {
        if (!text?.trim()) throw new Error("INSTRUCTION_REQUIRED");
        task.text += `\n\n追加指示:\n${text}`;
        task.updatedAt = Date.now();
        this.repository.put("task", task.id, task);
        this.repository.audit(actor, "task.steer", taskId);
        return;
      }
      if (!task.clientId) throw new Error("TASK_NOT_ASSIGNED");
      if (type === "retry") {
        if (
          !["completed", "failed", "cancelled", "interrupted"].includes(
            task.state,
          )
        )
          throw new Error("TASK_STILL_ACTIVE");
        task.history.push({
          revision: task.revision,
          text: task.text,
          result: task.result,
        });
        task.revision++;
        task.result = undefined;
        task.state = "assigned";
      } else if (
        type === "steer" &&
        !["assigned", "running"].includes(task.state)
      )
        throw new Error("TASK_NOT_RUNNING");
      this.repository.put("task", task.id, task);
      this.repository.enqueue(task.clientId, {
        type,
        taskId: task.id,
        runId: task.runId,
        revision: task.revision,
        text,
        task,
      });
      this.repository.audit(actor, `task.${type}`, taskId);
    });
  }
}
