import { randomUUID } from "node:crypto";
import {
  VoiceServiceError,
  voiceErrorCode,
  voiceErrorMessage,
} from "./discord-voice-errors.mjs";

const MAX_DISCORD_MESSAGE = 1_900;
const MAX_TRANSCRIPT_CHARACTERS = 8_000;
const MAX_CODEX_RESPONSE_CHARACTERS = 12_000;
const TRUNCATION_SUFFIX = " …（長さ上限で省略）";
const DEFAULT_STAGE_TIMEOUTS = Object.freeze({
  transcribing: 120_000,
  running_codex: 900_000,
  posting: 30_000,
  synthesizing: 120_000,
  speaking: 300_000,
});

export async function withTimeout(operation, timeoutMs, label) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const timeout = new VoiceServiceError(
            "STAGE_TIMEOUT",
            `${label} timed out after ${timeoutMs}ms`,
            "処理が制限時間を超えました。次の発話を受け付けます。",
          );
          reject(timeout);
          controller.abort(timeout);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function boundText(text, maximum, suffix = TRUNCATION_SUFFIX) {
  const normalized = String(text ?? "").trim();
  if (normalized.length <= maximum) return normalized;
  const safeSuffix = suffix.length < maximum ? suffix : "";
  return `${normalized.slice(0, maximum - safeSuffix.length).trimEnd()}${safeSuffix}`;
}

export function splitDiscordText(text, maximum = MAX_DISCORD_MESSAGE) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return [];
  const chunks = [];
  let remaining = normalized;
  while (remaining.length > maximum) {
    let cut = remaining.lastIndexOf("\n", maximum - 1);
    if (cut < maximum * 0.5) cut = remaining.lastIndexOf("。", maximum - 1);
    if (cut < maximum * 0.5) cut = remaining.lastIndexOf(" ", maximum - 1);
    if (cut < maximum * 0.5) cut = maximum;
    else cut += 1;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function speechExcerpt(text, maximum = 1_200) {
  if (!Number.isInteger(maximum) || maximum <= 0) return "";
  const normalized = String(text ?? "")
    .replace(/https?:\/\/\S+/g, "リンク")
    .trim();
  if (normalized.length <= maximum) return normalized;
  const safeSuffix =
    TRUNCATION_SUFFIX.length < maximum ? TRUNCATION_SUFFIX : "";
  const budget = maximum - safeSuffix.length;
  const candidate = normalized.slice(0, budget);
  const boundary = Math.max(
    candidate.lastIndexOf("。"),
    candidate.lastIndexOf("\n"),
  );
  const excerpt = candidate.slice(
    0,
    boundary > budget * 0.6 ? boundary + 1 : budget,
  );
  return `${excerpt.trimEnd()}${safeSuffix}`;
}

export class DiscordVoiceSession {
  constructor({
    transcribe,
    runCodex,
    synthesize,
    postText,
    playAudio,
    logger = console,
    maximumQueuedTurns = 3,
    stageTimeouts = {},
  }) {
    this.dependencies = {
      transcribe,
      runCodex,
      synthesize,
      postText,
      playAudio,
    };
    this.logger = logger;
    this.maximumQueuedTurns = maximumQueuedTurns;
    this.stageTimeouts = { ...DEFAULT_STAGE_TIMEOUTS, ...stageTimeouts };
    this.queue = [];
    this.processing = false;
    this.state = "idle";
  }

  enqueue(wav, metadata = {}) {
    if (!Buffer.isBuffer(wav)) throw new TypeError("wav must be a Buffer");
    if (this.queue.length >= this.maximumQueuedTurns) return false;
    this.queue.push({ id: randomUUID(), wav, metadata, queuedAt: Date.now() });
    void this.#drain();
    return true;
  }

  async #drain() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length) {
      const turn = this.queue.shift();
      await this.#processTurn(turn);
    }
    this.state = "idle";
    this.processing = false;
  }

  async #processTurn(turn) {
    const startedAt = Date.now();
    try {
      this.state = "transcribing";
      const transcript = boundText(
        await withTimeout(
          (signal) => this.dependencies.transcribe(turn.wav, { signal }),
          this.stageTimeouts.transcribing,
          "transcribing",
        ),
        MAX_TRANSCRIPT_CHARACTERS,
      );
      if (!transcript) {
        this.#log("discarded", turn, startedAt, { reason: "empty_transcript" });
        return;
      }
      const transcriptChunks = splitDiscordText(
        `🎙️ **聞き取った内容**\n${transcript}`,
      );
      for (const chunk of transcriptChunks) {
        await withTimeout(
          (signal) => this.dependencies.postText(chunk, { signal }),
          this.stageTimeouts.posting,
          "posting transcript",
        );
      }

      this.state = "running_codex";
      const response = boundText(
        await withTimeout(
          (signal) => this.dependencies.runCodex(transcript, { signal }),
          this.stageTimeouts.running_codex,
          "running_codex",
        ),
        MAX_CODEX_RESPONSE_CHARACTERS,
      );
      const chunks = splitDiscordText(
        response || "Codexから空の応答が返りました。",
      );
      for (const chunk of chunks) {
        await withTimeout(
          (signal) => this.dependencies.postText(chunk, { signal }),
          this.stageTimeouts.posting,
          "posting response",
        );
      }

      const spoken = speechExcerpt(response);
      if (spoken) {
        this.state = "synthesizing";
        const audio = await withTimeout(
          (signal) => this.dependencies.synthesize(spoken, { signal }),
          this.stageTimeouts.synthesizing,
          "synthesizing",
        );
        this.state = "speaking";
        await withTimeout(
          (signal) => this.dependencies.playAudio(audio, { signal }),
          this.stageTimeouts.speaking,
          "speaking",
        );
      }
      this.#log("completed", turn, startedAt, {
        transcriptCharacters: transcript.length,
        responseCharacters: response.length,
      });
    } catch (error) {
      this.#log("failed", turn, startedAt, {
        stage: this.state,
        errorCode: voiceErrorCode(error),
      });
      await withTimeout(
        (signal) =>
          this.dependencies.postText(
            `⚠️ 音声ターンを完了できませんでした（${this.state}）。${voiceErrorMessage(error)}`,
            { signal },
          ),
        this.stageTimeouts.posting,
        "posting error",
      ).catch(() => undefined);
    }
  }

  #log(event, turn, startedAt, detail) {
    try {
      this.logger.info?.({
        component: "discord-voice",
        event,
        turnId: turn.id,
        elapsedMs: Date.now() - startedAt,
        ...detail,
      });
    } catch {
      // Logging must never stop the serialized voice queue.
    }
  }
}
