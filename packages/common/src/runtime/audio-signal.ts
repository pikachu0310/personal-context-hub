// Shared by capture and STT. Removing the mean rejects DC as well as silence.
export function pcmSignalRms(pcm: Buffer) {
  let sum = 0,
    square = 0;
  const samples = Math.floor(pcm.length / 2);
  for (let i = 0; i < samples * 2; i += 2) {
    const value = pcm.readInt16LE(i);
    sum += value;
    square += value * value;
  }
  return samples
    ? Math.sqrt(Math.max(0, square / samples - (sum / samples) ** 2))
    : 0;
}

export const VOICE_TIMING = Object.freeze({
  interruptMs: 1200,
  resetSilenceMs: 300,
  quietMs: 1000,
  candidateTtlMs: 90_000,
});

// One instance per subject/utterance; decoder chunk boundaries are arbitrary.
export class SpeechActivityGate {
  private pending = Buffer.alloc(0);
  private activeMs = 0;
  private silentMs = 0;
  private lastPush?: number;
  private lastSignal?: number;
  private interrupted = false;
  constructor(private readonly now = Date.now) {}
  push(pcm: Buffer): boolean {
    const at = this.now();
    if (
      this.lastPush !== undefined &&
      at - this.lastPush >= VOICE_TIMING.resetSilenceMs
    ) {
      this.activeMs = 0;
      this.silentMs = 0;
      this.pending = Buffer.alloc(0);
    }
    this.lastPush = at;
    this.pending = Buffer.concat([this.pending, pcm]);
    let interrupt = false;
    while (this.pending.length >= 3840) {
      const frame = this.pending.subarray(0, 3840);
      this.pending = this.pending.subarray(3840);
      if (pcmSignalRms(frame) >= 80) {
        this.lastSignal = at;
        this.silentMs = 0;
        this.activeMs += 20;
        if (!this.interrupted && this.activeMs >= VOICE_TIMING.interruptMs) {
          this.interrupted = true;
          interrupt = true;
        }
      } else {
        this.silentMs += 20;
        if (this.silentMs >= VOICE_TIMING.resetSilenceMs) this.activeMs = 0;
      }
    }
    return interrupt;
  }
  get silenceMs() {
    return Math.min(
      VOICE_TIMING.quietMs,
      Math.max(
        this.silentMs,
        this.lastSignal === undefined
          ? VOICE_TIMING.quietMs
          : this.now() - this.lastSignal,
      ),
    );
  }
}
