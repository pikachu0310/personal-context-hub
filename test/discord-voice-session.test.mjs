import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscordVoiceSession,
  speechExcerpt,
  splitDiscordText,
} from "../src/discord-voice-session.mjs";

async function eventually(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition was not reached");
}

test("a voice turn is transcribed, run through Codex, posted, and spoken in order", async () => {
  const calls = [];
  const session = new DiscordVoiceSession({
    transcribe: async (wav) => (
      calls.push(["stt", wav.length]),
      "このリポジトリを確認して"
    ),
    runCodex: async (text) => (
      calls.push(["codex", text]),
      "確認しました。テストは成功しています。"
    ),
    postText: async (text) => calls.push(["post", text]),
    synthesize: async (text) => (calls.push(["tts", text]), Buffer.from("pcm")),
    playAudio: async (audio) => calls.push(["play", audio.toString()]),
    logger: { info: () => undefined },
  });

  assert.equal(session.enqueue(Buffer.from("wav")), true);
  await eventually(
    () => session.state === "idle" && calls.some(([kind]) => kind === "play"),
  );
  assert.deepEqual(
    calls.map(([kind]) => kind),
    ["stt", "post", "codex", "post", "tts", "play"],
  );
});

test("a failed STT turn reports the stage and the next queued turn still runs", async () => {
  let transcriptions = 0;
  const posts = [];
  const session = new DiscordVoiceSession({
    transcribe: async () => {
      transcriptions += 1;
      if (transcriptions === 1) throw new Error("temporary STT error");
      return "二つ目";
    },
    runCodex: async () => "完了",
    postText: async (text) => posts.push(text),
    synthesize: async () => Buffer.alloc(2),
    playAudio: async () => undefined,
    logger: { info: () => undefined },
  });
  session.enqueue(Buffer.from("one"));
  session.enqueue(Buffer.from("two"));
  await eventually(
    () => session.state === "idle" && posts.some((text) => text === "完了"),
  );
  assert.match(posts[0], /transcribing/);
  assert.ok(posts.some((text) => text.includes("二つ目")));
});

test("message splitting and speech excerpts keep bounded outputs", () => {
  const chunks = splitDiscordText(`${"a".repeat(1_500)}\n${"b".repeat(1_500)}`);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 1_900));
  const spoken = speechExcerpt(
    `${"応答。".repeat(500)} https://example.com/private`,
  );
  assert.ok(spoken.length <= 1_230);
  assert.doesNotMatch(spoken, /example\.com/);
});
