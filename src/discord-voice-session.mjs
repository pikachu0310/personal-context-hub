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

function safeSliceEnd(text, end) {
  if (end <= 0 || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
    ? end - 1
    : end;
}

export async function withTimeout(operation, timeoutMs, label, parentSignal) {
  if (parentSignal?.aborted) {
    throw (
      parentSignal.reason ??
      new VoiceServiceError(
        "SERVICE_STOPPED",
        `${label} cancelled because the voice service stopped.`,
        "音声サービスを停止しました。",
      )
    );
  }
  const controller = new AbortController();
  let timer;
  let removeParentAbort = () => undefined;
  try {
    const parentAbort = new Promise((_, reject) => {
      if (!parentSignal) return;
      const abort = () => {
        const reason =
          parentSignal.reason ??
          new VoiceServiceError(
            "SERVICE_STOPPED",
            `${label} cancelled because the voice service stopped.`,
            "音声サービスを停止しました。",
          );
        controller.abort(reason);
        reject(reason);
      };
      if (parentSignal.aborted) {
        abort();
        return;
      }
      parentSignal.addEventListener("abort", abort, { once: true });
      removeParentAbort = () =>
        parentSignal.removeEventListener("abort", abort);
    });
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      parentAbort,
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
    removeParentAbort();
  }
}

export function boundText(text, maximum, suffix = TRUNCATION_SUFFIX) {
  if (!Number.isInteger(maximum) || maximum <= 0) return "";
  const normalized = String(text ?? "").trim();
  if (normalized.length <= maximum) return normalized;
  const safeSuffix = suffix.length < maximum ? suffix : "";
  const end = safeSliceEnd(normalized, maximum - safeSuffix.length);
  return `${normalized.slice(0, end).trimEnd()}${safeSuffix}`;
}

export function splitDiscordText(text, maximum = MAX_DISCORD_MESSAGE) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return [];
  if (!Number.isInteger(maximum) || maximum < 2) return [normalized];
  const chunks = [];
  let remaining = normalized;
  while (remaining.length > maximum) {
    let cut = remaining.lastIndexOf("\n", maximum - 1);
    if (cut < maximum * 0.5) cut = remaining.lastIndexOf("。", maximum - 1);
    if (cut < maximum * 0.5) cut = remaining.lastIndexOf(" ", maximum - 1);
    if (cut < maximum * 0.5) cut = maximum;
    else cut += 1;
    cut = safeSliceEnd(remaining, cut);
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
  const candidate = normalized.slice(0, safeSliceEnd(normalized, budget));
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
    this.closed = false;
    this.shutdownController = new AbortController();
    this.stoppedAtStage = undefined;
  }

  enqueue(wav, metadata = {}) {
    if (!Buffer.isBuffer(wav)) throw new TypeError("wav must be a Buffer");
    if (this.closed) return false;
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
    this.state = this.closed ? "stopped" : "idle";
    this.processing = false;
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.stoppedAtStage = this.state;
    this.state = "stopped";
    this.shutdownController.abort(
      new VoiceServiceError(
        "SERVICE_STOPPED",
        "Discord voice session stopped.",
        "音声サービスを停止しました。",
      ),
    );
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
          this.shutdownController.signal,
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
      this.state = "posting_transcript";
      for (const chunk of transcriptChunks) {
        await withTimeout(
          (signal) => this.dependencies.postText(chunk, { signal }),
          this.stageTimeouts.posting,
          "posting transcript",
          this.shutdownController.signal,
        );
      }

      this.state = "running_codex";
      const response = boundText(
        await withTimeout(
          (signal) => this.dependencies.runCodex(transcript, { signal }),
          this.stageTimeouts.running_codex,
          "running_codex",
          this.shutdownController.signal,
        ),
        MAX_CODEX_RESPONSE_CHARACTERS,
      );
      const chunks = splitDiscordText(
        response || "Codexから空の応答が返りました。",
      );
      this.state = "posting_response";
      for (const chunk of chunks) {
        await withTimeout(
          (signal) => this.dependencies.postText(chunk, { signal }),
          this.stageTimeouts.posting,
          "posting response",
          this.shutdownController.signal,
        );
      }

      const spoken = speechExcerpt(response);
      if (spoken) {
        this.state = "synthesizing";
        const audio = await withTimeout(
          (signal) => this.dependencies.synthesize(spoken, { signal }),
          this.stageTimeouts.synthesizing,
          "synthesizing",
          this.shutdownController.signal,
        );
        this.state = "speaking";
        await withTimeout(
          (signal) => this.dependencies.playAudio(audio, { signal }),
          this.stageTimeouts.speaking,
          "speaking",
          this.shutdownController.signal,
        );
      }
      this.#log("completed", turn, startedAt, {
        transcriptCharacters: transcript.length,
        responseCharacters: response.length,
      });
    } catch (error) {
      if (this.closed) {
        this.#log("cancelled", turn, startedAt, {
          stage: this.stoppedAtStage ?? this.state,
          errorCode: voiceErrorCode(error),
        });
        return;
      }
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
        this.shutdownController.signal,
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
