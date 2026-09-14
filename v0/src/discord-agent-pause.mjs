// Keep the existing Discord lease while paused; never create a second task.
export class AgentPausableExecution {
  constructor({ execute, onState = () => {} }) {
    this.execute = execute;
    this.onState = onState;
    this.runs = new Map();
  }
  async pause(id) {
    const run = this.runs.get(id);
    if (!run || run.paused || run.signal?.aborted) return false;
    run.paused = true;
    this.onState(id, "pausing");
    run.controller?.abort();
    await run.attempt?.catch(() => {});
    if (this.runs.get(id) === run && !run.signal?.aborted)
      this.onState(id, "paused");
    return true;
  }
  resume(id, networkAccess) {
    const run = this.runs.get(id);
    if (
      !run?.paused ||
      !run.wake ||
      typeof networkAccess !== "boolean" ||
      run.signal?.aborted
    )
      return false;
    run.networkAccess = networkAccess;
    run.paused = false;
    run.wake();
    return true;
  }
  async run(task, options, networkAccess) {
    const id = String(task.id);
    const run = { signal: options.signal, networkAccess, paused: false };
    this.runs.set(id, run);
    try {
      for (;;) {
        run.signal?.throwIfAborted();
        if (run.paused)
          await new Promise((resolve) => {
            const wake = () => {
              run.signal?.removeEventListener("abort", wake);
              run.wake = undefined;
              resolve();
            };
            run.wake = wake;
            run.signal?.addEventListener("abort", wake, { once: true });
            if (run.signal?.aborted) wake();
          });
        run.signal?.throwIfAborted();
        run.controller = new AbortController();
        const signal = run.signal
          ? AbortSignal.any([run.signal, run.controller.signal])
          : run.controller.signal;
        this.onState(id, "running");
        run.attempt = Promise.resolve().then(() =>
          this.execute(task, { ...options, signal }, run.networkAccess),
        );
        try {
          const result = await run.attempt;
          if (!run.paused) return result;
        } catch (error) {
          if (!run.paused || run.signal?.aborted) throw error;
        }
      }
    } finally {
      if (this.runs.get(id) === run) this.runs.delete(id);
    }
  }
}
