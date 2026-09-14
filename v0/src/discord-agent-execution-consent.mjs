import { randomUUID } from "node:crypto";

// Consent is scoped to this connection, never persisted or accepted from a task.
export class AgentExecutionConsent {
  constructor({ executor, automatic = false, timeoutMs = 90_000 }) {
    this.executor = executor;
    this.automatic = automatic === true;
    this.timeoutMs = timeoutMs;
    this.pending = new Map();
  }

  describe() {
    return [...this.pending.values()].map(({ request }) => request);
  }

  decide(id, approved) {
    const pending = this.pending.get(id);
    if (!pending) return false;
    pending.finish(approved === true);
    return true;
  }

  async run(task, options = {}) {
    if (!this.automatic) {
      if (options.signal?.aborted)
        throw new Error("Task cancelled before approval.");
      const id = randomUUID();
      const allowed = await new Promise((resolve) => {
        const finish = (value) => {
          clearTimeout(timer);
          options.signal?.removeEventListener("abort", abort);
          this.pending.delete(id);
          resolve(value);
        };
        const abort = () => finish(false);
        const timer = setTimeout(() => finish(false), this.timeoutMs);
        this.pending.set(id, {
          finish,
          request: {
            id,
            taskId: String(task.id ?? task.taskId ?? ""),
            title: String(task.title ?? "").slice(0, 200),
            request: String(task.request ?? "").slice(0, 20_000),
            context: String(task.context ?? "").slice(0, 20_000),
            additionalInstruction: String(
              task.additionalInstruction ?? "",
            ).slice(0, 20_000),
            expiresAt: Date.now() + this.timeoutMs,
          },
        });
        options.signal?.addEventListener("abort", abort, { once: true });
      });
      if (!allowed || options.signal?.aborted)
        throw new Error("The participant did not approve this task.");
    }
    return this.executor.run(task, options);
  }
}
