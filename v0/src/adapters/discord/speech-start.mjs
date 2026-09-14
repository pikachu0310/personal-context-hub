// This gate controls only playback admission. Once admitted, human speech does
// not interrupt playback. Track the receiver, independently of the STT allowlist.
export class SpeechStartGate {
  constructor(
    speaking,
    {
      silenceMs = 1_000,
      now = () => performance.now(),
      schedule = setTimeout,
      cancel = clearTimeout,
    } = {},
  ) {
    this.speaking = speaking;
    this.silenceMs = silenceMs;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.active = new Set(speaking.users?.keys());
    this.quietSince = now();
    this.waiters = new Set();
    this.onStart = (userId) => {
      this.active.add(userId);
      this.#update();
    };
    this.onEnd = (userId) => {
      if (!this.active.delete(userId)) return;
      if (!this.active.size) this.quietSince = now();
      this.#update();
    };
    speaking.on("start", this.onStart);
    speaking.on("end", this.onEnd);
  }

  #update() {
    for (const check of [...this.waiters]) check();
  }

  runWhenQuiet(start, { signal } = {}) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        this.cancel(timer);
        this.waiters.delete(check);
        signal?.removeEventListener("abort", check);
      };
      const check = () => {
        this.cancel(timer);
        timer = undefined;
        if (signal?.aborted || this.closedError) {
          cleanup();
          reject(signal?.aborted ? signal.reason : this.closedError);
          return;
        }
        if (this.active.size) return;
        const remaining = this.silenceMs - (this.now() - this.quietSince);
        if (remaining > 0) {
          timer = this.schedule(check, remaining);
          return;
        }
        cleanup();
        // Check and start in the same synchronous callback: do not yield between
        // admitting playback and actually calling player.play().
        try {
          resolve(start());
        } catch (error) {
          reject(error);
        }
      };
      this.waiters.add(check);
      signal?.addEventListener("abort", check, { once: true });
      check();
    });
  }

  dispose() {
    this.closedError ??= new Error("Speech start gate closed");
    this.speaking.off("start", this.onStart);
    this.speaking.off("end", this.onEnd);
    this.#update();
  }
}
