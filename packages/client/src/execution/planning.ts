import type { Executor, Run } from "./executor.js";
import { recordActivity } from "./activity.js";
import { HttpError } from "@ido/common/runtime/http";

export function waitForPlan(
  this: Executor,
  value: Run,
  signal: AbortSignal,
): Promise<"discuss" | "execute"> {
  signal.throwIfAborted();
  if (
    value.instructions?.some(
      (instruction) => instruction.delivery === "pending",
    )
  )
    return Promise.resolve("discuss");
  return new Promise((resolve, reject) => {
    const abort = () => {
      this.planWaiters.delete(value.task.runId);
      reject(signal.reason ?? new Error("CANCELLED"));
    };
    this.planWaiters.set(value.task.runId, (choice) => {
      signal.removeEventListener("abort", abort);
      this.planWaiters.delete(value.task.runId);
      resolve(choice);
    });
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function startPlannedWork(this: Executor, runId: string) {
  const value = this.runs[runId];
  if (!value || value.phase !== "awaiting-plan" || value.state !== "running")
    throw new HttpError(409, "PLAN_NOT_READY");
  const resume = this.planWaiters.get(runId);
  if (
    !resume ||
    value.instructions?.some(
      (instruction) => instruction.delivery !== "accepted",
    )
  )
    throw new HttpError(409, "PLAN_DISCUSSION_PENDING");
  value.planApproved = true;
  value.phase = "executing";
  recordActivity(value, {
    kind: "status",
    title: "計画の実行を依頼しました",
    text: "実行権限は変更せず、合意した計画に沿って作業を進めます。",
  });
  try {
    await this.save();
  } catch (error) {
    value.planApproved = false;
    value.phase = "awaiting-plan";
    throw error;
  }
  resume("execute");
}
