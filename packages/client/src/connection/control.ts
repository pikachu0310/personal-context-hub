import type { Client } from "../bootstrap/client.js";
import type { WorkReceipt } from "@ido/common/contracts/work";
import { HttpError } from "@ido/common/runtime/http";
export function control(
  this: Client,
  runId: string,
  requestKey: string,
  instruction: string,
): Promise<WorkReceipt> {
  const value = this.executor.runs[runId];
  if (!value) throw new HttpError(404, "RUN_NOT_FOUND");
  if (!this.connected || !this.controlSupported)
    throw new HttpError(409, "ENGINE_CONTROL_UNAVAILABLE");
  if (!this.allowedProjects.has(value.task.projectId))
    throw new HttpError(409, "EXECUTION_NOT_ALLOWED");
  if (!["assigned", "running"].includes(value.state))
    throw new HttpError(409, "TASK_NOT_RUNNING");
  if (this.controlRequests.has(requestKey))
    throw new HttpError(409, "CONTROL_PENDING");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      this.controlRequests.delete(requestKey);
      reject(new HttpError(504, "CONTROL_DELIVERY_UNKNOWN"));
    }, 10_000);
    this.controlRequests.set(requestKey, { resolve, reject, timer });
    this.emit({
      v: 1,
      type: "work.control",
      requestKey,
      runId,
      taskId: value.task.id,
      revision: value.task.revision,
      instruction,
    });
  });
}
