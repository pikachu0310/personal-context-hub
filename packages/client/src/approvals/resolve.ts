import type { Executor } from "../execution/executor.js";
export function approve(this: Executor, id: string, allow: boolean) {
  const request = this.approvals.get(id);
  if (!request) throw new Error("APPROVAL_EXPIRED");
  clearTimeout(request.timer);
  this.approvals.delete(id);
  request.resolve({ decision: allow ? "accept" : "decline" });
}
