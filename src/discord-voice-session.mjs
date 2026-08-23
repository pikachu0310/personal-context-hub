import { randomUUID } from "node:crypto";

const MAX_DISCORD_MESSAGE = 1_900;

export function splitDiscordText(text, maximum = MAX_DISCORD_MESSAGE) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return [];
  const chunks = [];
  let remaining = normalized;
  while (remaining.length > maximum) {
    let cut = remaining.lastIndexOf("\n", maximum);
    if (cut < maximum * 0.5) cut = remaining.lastIndexOf("。", maximum);
    if (cut < maximum * 0.5) cut = remaining.lastIndexOf(" ", maximum);
    if (cut < maximum * 0.5) cut = maximum;
    else cut += 1;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function speechExcerpt(text, maximum = 1_200) {
  const normalized = String(text ?? "")
    .replace(/https?:\/\/\S+/g, "リンク")
    .trim();
  if (normalized.length <= maximum) return normalized;
  const candidate = normalized.slice(0, maximum);
  const boundary = Math.max(
    candidate.lastIndexOf("。"),
    candidate.lastIndexOf("\n"),
  );
  return `${candidate.slice(0, boundary > maximum * 0.6 ? boundary + 1 : maximum)} 以下はテキストで確認してください。`;
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
      const transcript = String(
        await this.dependencies.transcribe(turn.wav),
      ).trim();
      if (!transcript) {
        this.#log("discarded", turn, startedAt, { reason: "empty_transcript" });
        return;
      }
      await this.dependencies.postText(`🎙️ **聞き取った内容**\n${transcript}`);

      this.state = "running_codex";
      const response = String(
        await this.dependencies.runCodex(transcript),
      ).trim();
      const chunks = splitDiscordText(
        response || "Codexから空の応答が返りました。",
      );
      for (const chunk of chunks) await this.dependencies.postText(chunk);

      const spoken = speechExcerpt(response);
      if (spoken) {
        this.state = "speaking";
        const audio = await this.dependencies.synthesize(spoken);
        await this.dependencies.playAudio(audio);
      }
      this.#log("completed", turn, startedAt, {
        transcriptCharacters: transcript.length,
        responseCharacters: response.length,
      });
    } catch (error) {
      this.#log("failed", turn, startedAt, {
        stage: this.state,
        error: error?.message ?? String(error),
      });
      await this.dependencies
        .postText(
          `⚠️ 音声ターンを完了できませんでした（${this.state}）。${error?.message ?? error}`,
        )
        .catch(() => undefined);
    }
  }

  #log(event, turn, startedAt, detail) {
    this.logger.info?.({
      component: "discord-voice",
      event,
      turnId: turn.id,
      elapsedMs: Date.now() - startedAt,
      ...detail,
    });
  }
}
