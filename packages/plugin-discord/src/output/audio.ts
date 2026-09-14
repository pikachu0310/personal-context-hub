import {
  AudioPlayerStatus,
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import type { DiscordState } from "../runtime/state.js";

function decode(value: unknown, maximum: number, alignment: number) {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(maximum / 3) * 4 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  )
    throw new Error("INVALID_AUDIO_FRAME");
  const bytes = Buffer.from(value, "base64");
  if (
    !bytes.length ||
    bytes.length > maximum ||
    bytes.length % alignment ||
    bytes.toString("base64") !== value
  )
    throw new Error("INVALID_AUDIO_FRAME");
  return bytes;
}
function discordPcm(pcm: Buffer) {
  const output = Buffer.alloc(pcm.length * 4);
  for (
    let source = 0, target = 0;
    source < pcm.length;
    source += 2, target += 8
  ) {
    const sample = pcm.readInt16LE(source);
    for (let offset = 0; offset < 8; offset += 2)
      output.writeInt16LE(sample, target + offset);
  }
  return output;
}
export class DiscordAudioOutput {
  private queue = Promise.resolve();
  private cancelled = new Set<string>();
  private currentId?: string;
  private currentCancel?: () => void;
  private quietSince = 0;
  private raw?: {
    id: string;
    stream: Readable;
    pending: Buffer;
    timer: NodeJS.Timeout;
  };
  private sequences = new Map<string, number>();
  constructor(
    readonly state: DiscordState,
    readonly quietMs = 1000,
    readonly resource = createAudioResource,
  ) {}
  private valid(message: Record<string, unknown>) {
    return (
      message.channelId === this.state.config.textChannelId &&
      message.speechEpoch === this.state.speechEpoch &&
      (!message.audioSessionId ||
        message.audioSessionId === this.state.audioSessionId) &&
      this.state.voice?.state.status === VoiceConnectionStatus.Ready &&
      !this.cancelled.has(String(message.candidateId))
    );
  }
  speakerStart(subject: string) {
    this.state.activeSpeakers.add(subject);
    this.state.playbackRevision = (this.state.playbackRevision ?? 0) + 1;
  }
  speakerInterrupt() {
    this.stop(this.currentId ?? this.raw?.id);
  }
  speakerEnd(subject: string, silenceMs = 0) {
    this.state.activeSpeakers.delete(subject);
    this.quietSince = Date.now() - Math.min(this.quietMs, silenceMs);
  }
  private clear() {
    this.currentCancel?.();
    if (this.raw) {
      clearInterval(this.raw.timer);
      this.raw.stream.push(null);
      this.raw = undefined;
    }
    this.state.player.stop(true);
  }
  stop(candidateId?: string) {
    if (candidateId) {
      this.cancelled.add(candidateId);
      if (this.cancelled.size > 200)
        this.cancelled.delete(this.cancelled.values().next().value!);
    }
    if (
      !candidateId ||
      this.currentId === candidateId ||
      this.raw?.id === candidateId
    )
      this.clear();
  }
  invalidate() {
    this.state.activeSpeakers.clear();
    this.clear();
  }
  deliver(message: Record<string, unknown>): Promise<void> {
    if (message.kind === "audio-stop") {
      if (this.valid(message))
        this.stop(
          typeof message.candidateId === "string"
            ? message.candidateId
            : undefined,
        );
      return Promise.resolve();
    }
    if (message.kind === "audio-frame") {
      this.append(message);
      return Promise.resolve();
    }
    const started = Date.now();
    const operation = this.queue
      .catch(() => {})
      .then(async () => {
        while (
          this.valid(message) &&
          (this.state.activeSpeakers.size ||
            Date.now() - this.quietSince < this.quietMs)
        ) {
          if (Date.now() - started > 60000)
            throw new Error("AUDIO_PLAYBACK_TIMEOUT");
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (
          !this.valid(message) ||
          (message.playbackRevision !== undefined &&
            message.playbackRevision !== this.state.playbackRevision)
        )
          throw new Error("AUDIO_PLAYBACK_DISCARDED");
        const audio = decode(message.audio, 6 * 1024 * 1024, 1);
        if (message.audioFormat && message.audioFormat !== "ogg-opus")
          throw new Error("INVALID_AUDIO_FORMAT");
        this.clear();
        this.currentId = String(message.candidateId ?? message.eventId);
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (error?: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            this.state.player.off("stateChange", changed);
            this.state.player.off("error", failed);
            this.currentCancel = undefined;
            this.currentId = undefined;
            if (error) reject(error);
            else resolve();
          };
          const changed = (_old: unknown, next: { status: string }) => {
            if (next.status === AudioPlayerStatus.Idle) settle();
          };
          const failed = () => settle(new Error("AUDIO_PLAYBACK_FAILED"));
          const timer = setTimeout(
            () => {
              settle(new Error("AUDIO_PLAYBACK_TIMEOUT"));
              this.state.player.stop(true);
            },
            Math.max(1, 60000 - (Date.now() - started)),
          );
          this.currentCancel = () =>
            settle(new Error("AUDIO_PLAYBACK_INTERRUPTED"));
          this.state.player.on("stateChange", changed);
          this.state.player.on("error", failed);
          try {
            this.state.player.play(
              this.resource(Readable.from(audio), {
                inputType: StreamType.OggOpus,
              }),
            );
          } catch {
            failed();
          }
        });
      });
    this.queue = operation.catch(() => {});
    return operation;
  }
  private append(message: Record<string, unknown>) {
    if (
      message.audioFormat !== "pcm16-24000-mono" ||
      typeof message.candidateId !== "string" ||
      !Number.isSafeInteger(message.audioSequence)
    )
      throw new Error("INVALID_AUDIO_FRAME");
    const pcm = decode(message.audio, 9600, 2);
    if (!this.valid(message)) return;
    // A backchannel may overlap an existing stream, but never starts a new one.
    if (
      this.raw?.id !== message.candidateId &&
      (this.state.activeSpeakers.size ||
        Date.now() - this.quietSince < this.quietMs ||
        (message.playbackRevision !== undefined &&
          message.playbackRevision !== this.state.playbackRevision))
    )
      return;
    const id = message.candidateId;
    const sequence = Number(message.audioSequence);
    if (sequence < 0 || sequence <= (this.sequences.get(id) ?? -1)) return;
    this.sequences.set(id, sequence);
    if (this.sequences.size > 200)
      this.sequences.delete(this.sequences.keys().next().value!);
    if (this.raw?.id !== id) {
      this.clear();
      const stream = new Readable({ read() {} });
      const raw = {
        id,
        stream,
        pending: Buffer.alloc(0),
        timer: undefined as unknown as NodeJS.Timeout,
      };
      raw.timer = setInterval(() => {
        if (this.raw !== raw || !this.valid(message)) {
          this.clear();
          return;
        }
        const frame = Buffer.alloc(960);
        raw.pending.copy(frame, 0, 0, Math.min(960, raw.pending.length));
        raw.pending = raw.pending.subarray(Math.min(960, raw.pending.length));
        if (stream.readableLength > 192000) {
          this.clear();
          return;
        }
        stream.push(discordPcm(frame));
      }, 20);
      raw.timer.unref();
      this.raw = raw;
      this.state.player.play(
        this.resource(stream, { inputType: StreamType.Raw }),
      );
    }
    if (this.raw!.pending.length + pcm.length > 240000) {
      this.clear();
      return;
    }
    this.raw!.pending = Buffer.concat([this.raw!.pending, pcm]);
  }
}
const outputs = new WeakMap<DiscordState, DiscordAudioOutput>();
export function audioOutput(state: DiscordState) {
  let output = outputs.get(state);
  if (!output) {
    output = new DiscordAudioOutput(state);
    outputs.set(state, output);
  }
  return output;
}
