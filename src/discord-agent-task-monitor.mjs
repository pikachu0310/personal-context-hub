// Bounded, local-only task state. Never persisted or sent to the gateway.
export class AgentTaskMonitor {
  constructor({ limit = 60, now = Date.now } = {}) {
    this.limit = limit;
    this.now = now;
    this.records = new Map();
    this.active = new Map();
  }
  list() {
    return [...this.records.values()].reverse().map((record) => ({
      ...record,
      workingDirectory:
        this.active.get(record.id)?.task.workingDirectory ??
        record.workingDirectory,
      logs: [...record.logs],
    }));
  }
  cancel(id) {
    const run = this.active.get(id);
    if (!run) return false;
    run.controller.abort();
    return true;
  }
  async close() {
    const runs = [...this.active.values()];
    for (const run of runs) run.controller.abort();
    await Promise.allSettled(runs.map((run) => run.done));
  }
  wrap(executor, { automatic = false, workingDirectory = "" } = {}) {
    return {
      run: (task, options = {}) => {
        const id = String(task.id);
        const controller = new AbortController();
        const signal = options.signal
          ? AbortSignal.any([options.signal, controller.signal])
          : controller.signal;
        const record = {
          id,
          title: String(task.title ?? "タスク").slice(0, 200),
          request: String(task.request ?? "").slice(0, 8000),
          state: automatic ? "running" : "awaiting_approval",
          startedAt: this.now(),
          workingDirectory,
          logs: [],
          source: "discord",
        };
        this.records.set(id, record);
        for (const [key] of this.records) {
          if (this.records.size <= this.limit) break;
          if (!this.active.has(key) && key !== id) this.records.delete(key);
        }
        const run = { controller, task };
        this.active.set(id, run);
        run.done = Promise.resolve()
          .then(() =>
            executor.run(task, {
              ...options,
              signal,
              onProgress: async (content) => {
                record.state = "running";
                record.logs.push({
                  at: this.now(),
                  text: String(content).slice(0, 2000),
                });
                if (record.logs.length > 30) record.logs.shift();
                await options.onProgress?.(content);
              },
            }),
          )
          .then(
            (result) => {
              record.state = signal.aborted ? "cancelled" : "completed";
              record.result = String(
                result?.response ?? result?.result ?? "",
              ).slice(0, 8000);
              return result;
            },
            (error) => {
              if (error?.code === "AGENT_SANDBOX_NOT_READY")
                record.errorMessage =
                  "読み取り専用の状態で起動されました。接続を停止し、接続設定のWindowsサンドボックスをセットアップしてから再接続してください。";
              record.state = signal.aborted
                ? "cancelled"
                : record.state === "awaiting_approval"
                  ? "not_started"
                  : "failed";
              throw error;
            },
          )
          .finally(() => {
            record.workingDirectory =
              task.workingDirectory ?? record.workingDirectory;
            record.finishedAt = this.now();
            if (this.active.get(id) === run) this.active.delete(id);
          });
        return run.done;
      },
    };
  }
  markRunning(id) {
    const record = this.records.get(String(id));
    if (record) record.state = "running";
  }
}
