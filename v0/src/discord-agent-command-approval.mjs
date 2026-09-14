import { randomUUID } from "node:crypto";

// Decisions are local, per operation, never session-wide or supplied by Discord.
export class AgentCommandApproval {
  constructor({ timeoutMs = 300000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }
  list() {
    return [...this.pending.values()].map(({ request }) => request);
  }
  decide(id, approved) {
    const entry = this.pending.get(id);
    if (!entry || typeof approved !== "boolean") return false;
    entry.finish(approved ? "accept" : "decline");
    return true;
  }
  close() {
    for (const entry of this.pending.values()) entry.finish("decline");
  }
  cancelTask(taskId) {
    for (const entry of this.pending.values())
      if (entry.request.taskId === String(taskId)) entry.finish("decline");
  }
  request(taskId, method, params, signal, { automatic = false } = {}) {
    if (
      signal?.aborted ||
      this.pending.size >= 16 ||
      ![
        "item/commandExecution/requestApproval",
        "item/fileChange/requestApproval",
        "item/permissions/requestApproval",
      ].includes(method)
    )
      return Promise.resolve({ decision: "decline" });
    if (automatic === true) return Promise.resolve({ decision: "accept" });
    const baseOperation =
      (method === "item/permissions/requestApproval"
        ? JSON.stringify(params.permissions ?? {})
        : params.command) ??
      (params.networkApprovalContext
        ? JSON.stringify(params.networkApprovalContext)
        : params.grantRoot);
    if (typeof baseOperation !== "string" || !baseOperation)
      return Promise.resolve({ decision: "decline" });
    const operation = [
      baseOperation,
      params.additionalPermissions
        ? JSON.stringify(params.additionalPermissions)
        : "",
      params.networkApprovalContext
        ? JSON.stringify(params.networkApprovalContext)
        : "",
    ]
      .filter(Boolean)
      .join("\n");
    if (
      operation.length > 16000 ||
      (params.availableDecisions &&
        !params.availableDecisions.includes("accept"))
    )
      return Promise.resolve({ decision: "decline" });
    const id = randomUUID();
    return new Promise((resolve) => {
      const abort = () => finish("decline");
      const finish = (decision) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        resolve({ decision });
      };
      const timer = setTimeout(() => finish("decline"), this.timeoutMs);
      this.pending.set(id, {
        finish,
        request: {
          id,
          taskId: String(taskId),
          operation,
          kind: method.includes("fileChange") ? "file" : "command",
          cwd: String(params.cwd ?? ""),
          reason: String(params.reason ?? ""),
          expiresAt: Date.now() + this.timeoutMs,
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
    });
  }
}
