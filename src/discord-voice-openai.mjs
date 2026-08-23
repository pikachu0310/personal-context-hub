import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Codex } from "@openai/codex-sdk";
import OpenAI, { toFile } from "openai";

export function createOpenAIAudioAdapter(config, { client } = {}) {
  const openai = client ?? new OpenAI({ apiKey: config.openaiApiKey });
  return {
    async transcribe(wav) {
      const result = await openai.audio.transcriptions.create({
        file: await toFile(wav, "discord-turn.wav", { type: "audio/wav" }),
        model: config.sttModel,
        language: "ja",
        prompt: "VRChat、Codex、Unity、UdonSharp、MaiRec、maimai、traP",
      });
      return result.text;
    },
    async synthesize(text) {
      const response = await openai.audio.speech.create({
        model: config.ttsModel,
        voice: config.ttsVoice,
        input: text,
        instructions:
          "日本語で、落ち着いた共同開発者として簡潔かつ自然に話してください。",
        response_format: "pcm",
      });
      return Buffer.from(await response.arrayBuffer());
    },
  };
}

export class CodexVoiceRunner {
  constructor(config, { codex } = {}) {
    this.config = config;
    this.codex = codex ?? new Codex();
    this.thread = undefined;
  }

  async run(transcript) {
    await this.#ensureThread();
    let result;
    try {
      result = await this.thread.run(
        "Discord音声から本人が依頼しています。日本語で、最初に結論を短く述べてください。" +
          "対象workspaceのAGENTS.mdを守り、依頼に必要な作業を最後まで行ってください。\n\n本人の発話:\n" +
          transcript,
      );
    } catch (error) {
      if (/access token could not be refreshed/i.test(error?.message ?? "")) {
        throw new Error(
          "WSL側のCodexログインが期限切れです。npx codex login --device-auth で再認証してください。",
        );
      }
      throw error;
    }
    if (this.thread.id) await this.#writeState(this.thread.id);
    return result.finalResponse;
  }

  async #ensureThread() {
    if (this.thread) return;
    const threadId = await this.#readThreadId();
    const options = {
      workingDirectory: this.config.workingDirectory,
      sandboxMode: this.config.codexSandbox,
      approvalPolicy: "never",
      networkAccessEnabled: true,
      model: this.config.codexModel,
    };
    this.thread = threadId
      ? this.codex.resumeThread(threadId, options)
      : this.codex.startThread(options);
  }

  async #readThreadId() {
    try {
      const state = JSON.parse(await readFile(this.config.statePath, "utf8"));
      return typeof state.threadId === "string" && state.threadId
        ? state.threadId
        : undefined;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw new Error(
        `Could not read Discord voice Codex state: ${error.message}`,
      );
    }
  }

  async #writeState(threadId) {
    await mkdir(dirname(this.config.statePath), { recursive: true });
    const temporaryPath = `${this.config.statePath}.${process.pid}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ threadId, updatedAt: new Date().toISOString() }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporaryPath, this.config.statePath);
    await chmod(this.config.statePath, 0o600).catch(() => undefined);
  }
}
