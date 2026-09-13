import { randomUUID } from "node:crypto";
import {
  VoiceServiceError,
  voiceErrorCode,
  voiceErrorMessage,
} from "./errors.mjs";
import {
  boundText,
  speechExcerpt,
  withTimeout,
  DEFAULT_STAGE_TIMEOUTS,
  MAX_TRANSCRIPT_CHARACTERS,
  MAX_RESPONSE_CHARACTERS,
} from "./shared.mjs";
import { plainPresentation } from "./output/presentation.mjs";
export class TurnSession {
  constructor({
    presentation = plainPresentation,
    speechEnabled = true,
    transcribe,
    run,
    synthesize,
    postText,
    playAudio,
    logger = console,
    maximumQueuedTurns = 3,
    stageTimeouts = {},
  }) {
    this.presentation = presentation;
    this.speechEnabled = speechEnabled;
    this.dependencies = {
      transcribe,
      run,
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
    if (!this.processing) this.processingOperation = this.#drain();
    return true;
  }

  addText(text, metadata = {}) {
    if (
      this.closed ||
      !String(text).trim() ||
      this.queue.length >= this.maximumQueuedTurns
    )
      return false;
    this.queue.push({
      id: metadata.inputId ?? randomUUID(),
      text,
      metadata,
      queuedAt: Date.now(),
    });
    if (!this.processing) this.processingOperation = this.#drain();
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
    if (this.closed) return this.processingOperation;
    this.closed = true;
    this.queue = [];
    this.stoppedAtStage = this.state;
    this.state = "stopped";
    this.shutdownController.abort(
      new VoiceServiceError(
        "SERVICE_STOPPED",
        "Voice session stopped.",
        "音声サービスを停止しました。",
      ),
    );
    return this.processingOperation;
  }

  async #processTurn(turn) {
    const startedAt = Date.now();
    try {
      this.state = "transcribing";
      const transcript = boundText(
        turn.text ??
          (await withTimeout(
            (signal) => this.dependencies.transcribe(turn.wav, { signal }),
            this.stageTimeouts.transcribing,
            "transcribing",
            this.shutdownController.signal,
          )),
        MAX_TRANSCRIPT_CHARACTERS,
      );
      if (!transcript) {
        this.#log("discarded", turn, startedAt, { reason: "empty_transcript" });
        return;
      }
      const transcriptChunks = this.presentation.splitText(
        this.presentation.transcript(transcript),
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
          (signal) =>
            this.dependencies.run(transcript, {
              signal,
              metadata: turn.metadata,
              requestId: turn.id,
            }),
          this.stageTimeouts.running_codex,
          "running_codex",
          this.shutdownController.signal,
        ),
        MAX_RESPONSE_CHARACTERS,
      );
      const chunks = this.presentation.splitText(
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
      if (spoken && this.speechEnabled) {
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
        component: "conversation-engine",
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
