import { randomUUID } from "node:crypto";
import { wav } from "./wav.js";

// One capture per Discord subject. PCM never mixes before attributed STT.
// Frames feed Live; complete bounded segments feed transcription independently.
export class VoiceCapture {
  private chunks: Buffer[] = [];
  private size = 0;
  private segmentIndex = 0;
  private frameSequence = 0;
  private samples = 0;
  private segmentSamples = 0;
  private closed = false;
  readonly utteranceId = randomUUID();
  readonly startedAt: number;
  readonly maximumBytes: number;
  constructor(
    readonly source: {
      sessionId: string;
      userId: string;
      guildId: string;
      channelId: string;
      meetingId: string;
      projectId?: string;
      speechEpoch: number;
    },
    readonly emit: (event: Record<string, unknown>) => void,
    { startedAt = Date.now(), maximumSeconds = 20 } = {},
  ) {
    if (maximumSeconds <= 0 || maximumSeconds > 20)
      throw new Error("INVALID_CAPTURE_LIMIT");
    this.startedAt = startedAt;
    this.maximumBytes = Math.max(
      4,
      Math.floor((maximumSeconds * 192000) / 4) * 4,
    );
    this.activity("start");
  }
  private envelope() {
    return {
      type: "input",
      ...this.source,
      capture: {
        sessionId: this.source.sessionId,
        utteranceId: this.utteranceId,
        segmentIndex: this.segmentIndex,
        startedAt: this.startedAt + this.segmentSamples / 48,
      },
    };
  }
  private activity(activity: "start" | "end") {
    this.emit({
      ...this.envelope(),
      eventId: `${this.utteranceId}:${activity}`,
      activity,
    });
  }
  push(chunk: Buffer) {
    if (this.closed) return;
    if (!Buffer.isBuffer(chunk) || chunk.length % 4)
      throw new Error("INVALID_PCM_FRAME");
    for (let offset = 0; offset < chunk.length;) {
      if (this.size === this.maximumBytes) this.segment(false);
      const size = Math.min(
        3840,
        chunk.length - offset,
        this.maximumBytes - this.size,
      );
      const frame = chunk.subarray(offset, offset + size);
      this.emit({
        ...this.envelope(),
        eventId: `${this.utteranceId}:frame:${this.frameSequence}`,
        audioFrame: {
          pcm: frame.toString("base64"),
          sampleRate: 48000,
          channels: 2,
          format: "pcm16",
          sequence: this.frameSequence++,
        },
      });
      this.chunks.push(Buffer.from(frame));
      this.size += size;
      this.samples += size / 4;
      offset += size;
    }
  }
  private segment(final: boolean, complete = final) {
    if (!this.size) return;
    const envelope = this.envelope();
    this.emit({
      ...envelope,
      eventId: `${this.utteranceId}:segment:${this.segmentIndex}`,
      audio: wav(Buffer.concat(this.chunks, this.size)).toString("base64"),
      capture: {
        ...envelope.capture,
        endedAt: this.startedAt + this.samples / 48,
        final,
        complete,
      },
    });
    this.segmentIndex++;
    this.segmentSamples = this.samples;
    this.chunks = [];
    this.size = 0;
  }
  finish(complete = true) {
    if (this.closed) return;
    this.closed = true;
    this.segment(true, complete);
    this.activity("end");
  }
}
