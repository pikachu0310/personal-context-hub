import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CodexVoiceRunner,
  createOpenAIAudioAdapter,
} from "../src/discord-voice-openai.mjs";

test("OpenAI audio adapter uses bounded Japanese STT and PCM TTS contracts", async () => {
  const calls = [];
  const client = {
    audio: {
      transcriptions: {
        create: async (input) => (
          calls.push(["stt", input]),
          { text: "こんにちは" }
        ),
      },
      speech: {
        create: async (input) => {
          calls.push(["tts", input]);
          return { arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer };
        },
      },
    },
  };
  const adapter = createOpenAIAudioAdapter(
    {
      openaiApiKey: "unused",
      sttModel: "gpt-transcribe",
      ttsModel: "gpt-4o-mini-tts",
      ttsVoice: "marin",
    },
    { client },
  );
  assert.equal(await adapter.transcribe(Buffer.from("wav")), "こんにちは");
  assert.deepEqual(await adapter.synthesize("返答"), Buffer.from([1, 2, 3]));
  assert.equal(calls[0][1].language, "ja");
  assert.equal(calls[1][1].response_format, "pcm");
});

test("Codex voice runner persists and resumes the same local thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "discord-voice-codex-"));
  const statePath = join(root, "state", "thread.json");
  const runs = [];
  const thread = {
    id: "01999999-1111-7777-8888-123456789012",
    run: async (prompt) => (
      runs.push(prompt),
      { finalResponse: "完了しました" }
    ),
  };
  const codex = {
    startThread: (options) => (runs.push(options), thread),
    resumeThread: () => assert.fail("first runner must start"),
  };
  const config = {
    statePath,
    workingDirectory: root,
    codexSandbox: "workspace-write",
    codexModel: undefined,
  };
  const first = new CodexVoiceRunner(config, { codex });
  assert.equal(await first.run("テストして"), "完了しました");
  const saved = JSON.parse(await readFile(statePath, "utf8"));
  assert.equal(saved.threadId, thread.id);
  assert.match(runs[1], /本人の発話/);

  let resumed;
  const second = new CodexVoiceRunner(config, {
    codex: {
      startThread: () => assert.fail("second runner must resume"),
      resumeThread: (id, options) => {
        resumed = { id, options };
        return thread;
      },
    },
  });
  await second.run("続けて");
  assert.equal(resumed.id, thread.id);
  assert.equal(resumed.options.workingDirectory, root);
});

test("Codex voice runner turns an expired WSL login into an actionable error", async () => {
  const root = await mkdtemp(join(tmpdir(), "discord-voice-expired-"));
  const runner = new CodexVoiceRunner(
    {
      statePath: join(root, "thread.json"),
      workingDirectory: root,
      codexSandbox: "read-only",
      codexModel: undefined,
    },
    {
      codex: {
        startThread: () => ({
          id: null,
          run: async () => {
            throw new Error("Your access token could not be refreshed.");
          },
        }),
      },
    },
  );
  await assert.rejects(() => runner.run("確認"), /device-auth/);
});
