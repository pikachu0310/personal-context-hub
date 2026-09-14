import { randomUUID } from "node:crypto";
import type { Command, Project, Task } from "@ido/common/contracts/protocol";
import type { Device } from "../../domain/models.js";
import type { Repository } from "../../ports/repository.js";
import {
  normalizeExecutionPolicy,
  restrictExecutionPolicy,
  requiresPolicySupport,
  type ClientControlReceipt,
  type WorkReceipt,
} from "@ido/common/contracts/work";

type CreateTaskInput = Pick<
  Task,
  "projectId" | "meetingId" | "authorId" | "text" | "requestId" | "network"
> &
  Partial<
    Pick<
      Task,
      | "title"
      | "kind"
      | "sourceIds"
      | "sourceStatements"
      | "sourceSequences"
      | "executionPolicy"
    >
  >;
export interface TaskControlOptions {
  continuation?: string;
  expectedRevision?: number;
  requestKey?: string;
  expectedControlVersion?: number;
  instructionResolution?: "retry" | "discard";
}
const receiptKey = (actor: string, taskId: string, requestKey: string) =>
  JSON.stringify([actor, taskId, requestKey]);

export class Tasks {
  constructor(readonly repository: Repository) {}
  createTask(input: CreateTaskInput): Task {
    if (!this.repository.get<Project>("project", input.projectId))
      throw new Error("PROJECT_NOT_FOUND");
    return this.repository.transaction(() => {
      const key = JSON.stringify([
        input.authorId,
        input.projectId,
        input.requestId,
      ]);
      const previous = this.repository.requestTask(key);
      if (previous) {
        const task = this.repository.get<Task>("task", previous)!;
        if (task.meetingId !== input.meetingId)
          throw new Error("REQUEST_MEETING_MISMATCH");
        return task;
      }
      const task: Task = {
        ...structuredClone(input),
        executionPolicy: normalizeExecutionPolicy(input.executionPolicy),
        network:
          input.network === true &&
          input.executionPolicy?.networkAccessEnabled !== false,
        id: randomUUID(),
        runId: randomUUID(),
        revision: 1,
        specRevision: 1,
        controlVersion: 0,
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
    return this.repository.transaction(() =>
      this.applyResult(deviceId, generation, data),
    );
  }
  private applyResult(deviceId: string, generation: number, data: Command) {
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
    let receiptChanged = false;
    for (const incoming of (Array.isArray(data.controlReceipts)
      ? data.controlReceipts.slice(0, 100)
      : []) as ClientControlReceipt[]) {
      const receipt = task.controlReceipts?.[incoming?.id];
      if (
        !receipt ||
        receipt.controlVersion !== incoming.controlVersion ||
        ![
          "pending",
          "queued",
          "applied",
          "stopped",
          "uncertain",
          "rejected",
        ].includes(incoming.delivery) ||
        ["applied", "stopped", "rejected", "uncertain"].includes(
          receipt.delivery,
        ) ||
        (receipt.delivery === "queued" && incoming.delivery === "pending") ||
        receipt.delivery === incoming.delivery
      )
        continue;
      receipt.delivery = incoming.delivery;
      this.repository.put(
        "task-control",
        receiptKey(receipt.authorId, task.id, receipt.requestKey),
        receipt,
      );
      receiptChanged = true;
    }
    const receiptOnly = () => {
      if (receiptChanged) this.repository.put("task", task.id, task);
      return receiptChanged;
    };
    if (["completed", "failed", "cancelled"].includes(task.state))
      return receiptOnly();
    const next = data.state;
    if (
      !["running", "interrupted", "completed", "failed", "cancelled"].includes(
        String(next),
      )
    )
      return receiptOnly();
    const resultSpecRevision =
      Number.isSafeInteger(data.specRevision) && Number(data.specRevision) > 0
        ? Number(data.specRevision)
        : 1;
    if (resultSpecRevision > (task.specRevision ?? 1)) return receiptOnly();
    task.effectiveExecutionPolicy = restrictExecutionPolicy(
      task.executionPolicy,
      task.effectiveExecutionPolicy,
      data.effectiveExecutionPolicy,
    );
    task.state = next as Task["state"];
    task.progress =
      typeof data.progress === "string"
        ? data.progress.slice(0, 16000)
        : task.progress;
    if (typeof data.result === "string") {
      task.result = data.result.slice(0, 64000);
      task.resultSpecRevision = resultSpecRevision;
    }
    if (["completed", "failed", "cancelled"].includes(String(next)))
      task.resultSpecRevision = resultSpecRevision;
    task.updatedAt = Date.now();
    this.repository.put("task", task.id, task);
    return true;
  }
  control(
    taskId: string,
    actor: string,
    type: "steer" | "stop" | "retry",
    text?: string,
    options: TaskControlOptions = {},
  ): WorkReceipt {
    return this.repository.transaction(() => {
      const task = this.repository.get<Task>("task", taskId);
      if (!task) throw new Error("TASK_NOT_FOUND");
      const requestKey = options.requestKey ?? randomUUID();
      if (!requestKey || requestKey.length > 500)
        throw new Error("INVALID_REQUEST_KEY");
      const key = receiptKey(actor, taskId, requestKey);
      const previous = this.repository.get<WorkReceipt>("task-control", key);
      if (previous) return previous;
      if (
        options.expectedRevision !== undefined &&
        options.expectedRevision !== task.revision
      )
        throw new Error("TASK_CONTROL_SUPERSEDED");
      if (options.continuation !== undefined) {
        if (type !== "retry" || !options.continuation.trim())
          throw new Error("INSTRUCTION_REQUIRED");
        if (
          Object.values(task.controlReceipts ?? {}).some(
            (r) => r.delivery === "uncertain",
          )
        )
          throw new Error("INSTRUCTION_DELIVERY_UNCERTAIN");
      }
      if (
        options.expectedControlVersion !== undefined &&
        options.expectedControlVersion !== (task.controlVersion ?? 0)
      )
        throw new Error("TASK_CONTROL_SUPERSEDED");
      if (
        options.instructionResolution !== undefined &&
        !["retry", "discard"].includes(options.instructionResolution)
      )
        throw new Error("INVALID_INSTRUCTION_RESOLUTION");
      if (type === "steer" && !text?.trim())
        throw new Error("INSTRUCTION_REQUIRED");
      task.controlVersion = (task.controlVersion ?? 0) + 1;
      task.specRevision ??= 1;
      if (type === "steer") task.specRevision++;
      const receipt: WorkReceipt = {
        id: randomUUID(),
        taskId,
        authorId: actor,
        requestKey,
        type,
        controlVersion: task.controlVersion,
        specRevision: task.specRevision,
        accepted: true,
        delivery: "pending",
      };
      task.controlReceipts ??= {};
      task.controlReceipts[receipt.id] = receipt;
      const persist = () => {
        task.updatedAt = Date.now();
        this.repository.put("task", task.id, task);
        this.repository.put("task-control", key, receipt);
        this.repository.audit(actor, `task.${type}`, taskId);
        return receipt;
      };
      if (type === "stop" && task.state === "queued") {
        task.state = "cancelled";
        receipt.delivery = "stopped";
        return persist();
      }
      if (type === "steer" && task.state === "queued") {
        task.text += `\n\n追加指示:\n${text}`;
        receipt.delivery = "queued";
        return persist();
      }
      if (!task.clientId) throw new Error("TASK_NOT_ASSIGNED");
      if (
        type !== "stop" &&
        requiresPolicySupport(
          restrictExecutionPolicy(
            task.executionPolicy,
            task.effectiveExecutionPolicy,
          ),
        ) &&
        this.repository.get<Device>("device", task.clientId)
          ?.executionPolicyVersion !== 1
      )
        throw new Error("WORKER_POLICY_UNSUPPORTED");
      if (type === "retry") {
        if (
          !["completed", "failed", "cancelled", "interrupted"].includes(
            task.state,
          )
        )
          throw new Error("TASK_STILL_ACTIVE");
        if (options.instructionResolution)
          for (const earlier of Object.values(task.controlReceipts)) {
            if (earlier.delivery !== "uncertain") continue;
            earlier.delivery =
              options.instructionResolution === "retry" ? "queued" : "rejected";
            this.repository.put(
              "task-control",
              receiptKey(earlier.authorId, task.id, earlier.requestKey),
              earlier,
            );
          }
        task.history.push({
          revision: task.revision,
          text: task.text,
          result: task.result,
          specRevision: task.specRevision,
          resultSpecRevision: task.resultSpecRevision,
        });
        task.revision++;
        if (options.continuation !== undefined) {
          task.text += `\n\n追加依頼:\n${options.continuation}`;
          task.specRevision++;
          receipt.specRevision = task.specRevision;
        }
        task.result = undefined;
        task.resultSpecRevision = undefined;
        task.state = "assigned";
      } else if (
        type === "steer" &&
        !["assigned", "running"].includes(task.state)
      )
        throw new Error("TASK_NOT_RUNNING");
      this.repository.enqueue(task.clientId, {
        type,
        taskId: task.id,
        runId: task.runId,
        revision: task.revision,
        text,
        task,
        receiptId: receipt.id,
        controlVersion: receipt.controlVersion,
        specRevision: receipt.specRevision,
        instructionResolution: options.instructionResolution,
        ...(options.continuation !== undefined
          ? { continuation: options.continuation }
          : {}),
      });
      return persist();
    });
  }
}
