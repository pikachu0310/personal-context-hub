import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscordVoiceSession,
  boundText,
  speechExcerpt,
  splitDiscordText,
  withTimeout,
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
  const logs = [];
  const session = new DiscordVoiceSession({
    transcribe: async () => {
      transcriptions += 1;
      if (transcriptions === 1)
        throw new Error("temporary STT error with secret-value");
      return "二つ目";
    },
    runCodex: async () => "完了",
    postText: async (text) => posts.push(text),
    synthesize: async () => Buffer.alloc(2),
    playAudio: async () => undefined,
    logger: { info: (entry) => logs.push(entry) },
  });
  session.enqueue(Buffer.from("one"));
  session.enqueue(Buffer.from("two"));
  await eventually(
    () => session.state === "idle" && posts.some((text) => text === "完了"),
  );
  assert.match(posts[0], /transcribing/);
  assert.ok(posts.some((text) => text.includes("二つ目")));
  assert.doesNotMatch(posts.join("\n"), /secret-value|temporary STT error/);
  assert.doesNotMatch(JSON.stringify(logs), /secret-value|temporary STT error/);
});

test("a Discord transcript post failure reports the exact stage", async () => {
  let postAttempts = 0;
  const posts = [];
  const logs = [];
  const session = new DiscordVoiceSession({
    transcribe: async () => "投稿テスト",
    runCodex: async () => "not reached",
    postText: async (text) => {
      postAttempts += 1;
      if (postAttempts === 1) throw new Error("private transport detail");
      posts.push(text);
    },
    synthesize: async () => Buffer.alloc(2),
    playAudio: async () => undefined,
    logger: { info: (entry) => logs.push(entry) },
  });

  session.enqueue(Buffer.from("post-failure"));
  await eventually(() => session.state === "idle" && posts.length === 1);

  assert.match(posts[0], /posting_transcript/);
  assert.doesNotMatch(posts[0], /private transport detail/);
  assert.ok(
    logs.some(
      (entry) =>
        entry.event === "failed" && entry.stage === "posting_transcript",
    ),
  );
});

test("a timed out STT turn cannot permanently block the next queued turn", async () => {
  let transcriptions = 0;
  const posts = [];
  const session = new DiscordVoiceSession({
    transcribe: async () => {
      transcriptions += 1;
      if (transcriptions === 1) return new Promise(() => undefined);
      return "タイムアウト後の発話";
    },
    runCodex: async () => "後続ターン完了",
    postText: async (text) => posts.push(text),
    synthesize: async () => Buffer.alloc(2),
    playAudio: async () => undefined,
    logger: { info: () => undefined },
    stageTimeouts: { transcribing: 10 },
  });
  session.enqueue(Buffer.from("hung"));
  session.enqueue(Buffer.from("next"));
  await eventually(
    () => session.state === "idle" && posts.includes("後続ターン完了"),
  );
  assert.match(posts[0], /制限時間/);
  assert.doesNotMatch(posts[0], /timed out|10ms/);
  assert.ok(posts.some((text) => text.includes("タイムアウト後の発話")));
});

test("stage timeout aborts cancellable work", async () => {
  let aborted = false;
  await assert.rejects(
    () =>
      withTimeout(
        (signal) =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(signal.reason);
            });
          }),
        10,
        "test-stage",
      ),
    (error) => error.code === "STAGE_TIMEOUT",
  );
  assert.equal(aborted, true);
});

test("parent cancellation releases work even when the dependency ignores its signal", async () => {
  const controller = new AbortController();
  const pending = withTimeout(
    () => new Promise(() => undefined),
    60_000,
    "test-stage",
    controller.signal,
  );
  controller.abort({ code: "SERVICE_STOPPED" });
  await assert.rejects(
    () => pending,
    (error) => error.code === "SERVICE_STOPPED",
  );

  let calledAfterStop = false;
  const alreadyStopped = new AbortController();
  alreadyStopped.abort({ code: "SERVICE_STOPPED" });
  await assert.rejects(
    () =>
      withTimeout(
        async () => {
          calledAfterStop = true;
        },
        60_000,
        "test-stage",
        alreadyStopped.signal,
      ),
    (error) => error.code === "SERVICE_STOPPED",
  );
  assert.equal(calledAfterStop, false);
});

test("session stop cancels the active turn, drops the queue, and rejects new audio", async () => {
  let transcriptions = 0;
  const posts = [];
  const logs = [];
  const session = new DiscordVoiceSession({
    transcribe: async () => {
      transcriptions += 1;
      return new Promise(() => undefined);
    },
    runCodex: async () => "not reached",
    postText: async (text) => posts.push(text),
    synthesize: async () => Buffer.alloc(2),
    playAudio: async () => undefined,
    logger: { info: (entry) => logs.push(entry) },
  });
  assert.equal(session.enqueue(Buffer.from("active")), true);
  assert.equal(session.enqueue(Buffer.from("queued")), true);
  await eventually(() => session.state === "transcribing");

  session.stop();
  session.stop();
  await eventually(() => session.state === "stopped" && !session.processing);

  assert.equal(transcriptions, 1);
  assert.deepEqual(posts, []);
  assert.equal(session.queue.length, 0);
  assert.equal(session.enqueue(Buffer.from("late")), false);
  assert.ok(
    logs.some(
      (entry) => entry.event === "cancelled" && entry.stage === "transcribing",
    ),
  );
});

test("message splitting and speech excerpts keep bounded outputs", () => {
  const chunks = splitDiscordText(`${"a".repeat(1_500)}\n${"b".repeat(1_500)}`);
  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 1_900));
  const spoken = speechExcerpt(
    `${"応答。".repeat(500)} https://example.com/private`,
  );
  assert.ok(spoken.length <= 1_200);
  assert.doesNotMatch(spoken, /example\.com/);
  assert.equal(boundText("x".repeat(10_000), 8_000).length, 8_000);
  assert.equal(boundText("text", 0), "");
  assert.deepEqual(splitDiscordText("😀", 1), ["😀"]);
  assert.equal(speechExcerpt("123456789", 5).length, 5);
  assert.equal(speechExcerpt("123456789", 0), "");

  const emojiBoundary = `${"a".repeat(9)}😀tail`;
  assert.equal(boundText(emojiBoundary, 10, ""), "a".repeat(9));
  const emojiChunks = splitDiscordText(emojiBoundary, 10);
  assert.equal(emojiChunks.join(""), emojiBoundary);
  for (const chunk of emojiChunks) {
    const first = chunk.charCodeAt(0);
    const last = chunk.charCodeAt(chunk.length - 1);
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff));
    assert.ok(!(last >= 0xd800 && last <= 0xdbff));
  }
});

test("transcripts and Codex responses are bounded before posting or speaking", async () => {
  const posts = [];
  let codexInput;
  let spoken;
  const session = new DiscordVoiceSession({
    transcribe: async () => "入力".repeat(10_000),
    runCodex: async (text) => {
      codexInput = text;
      return "回答".repeat(10_000);
    },
    postText: async (text) => posts.push(text),
    synthesize: async (text) => ((spoken = text), Buffer.alloc(2)),
    playAudio: async () => undefined,
    logger: { info: () => undefined },
  });
  session.enqueue(Buffer.from("wav"));
  await eventually(() => session.state === "idle" && spoken);
  assert.ok(codexInput.length <= 8_000);
  assert.ok(spoken.length <= 1_200);
  assert.ok(posts.every((text) => text.length <= 1_900));
  assert.ok(posts.length <= 12);
});

test("long transcripts are posted in Discord-safe chunks before Codex runs", async () => {
  const events = [];
  const transcript = "長い発話。".repeat(600);
  const session = new DiscordVoiceSession({
    transcribe: async () => transcript,
    runCodex: async () => (events.push("codex"), "了解"),
    postText: async (text) => events.push(text),
    synthesize: async () => Buffer.alloc(2),
    playAudio: async () => undefined,
    logger: { info: () => undefined },
  });
  session.enqueue(Buffer.from("wav"));
  await eventually(() => session.state === "idle" && events.includes("了解"));
  const transcriptPosts = events.slice(0, events.indexOf("codex"));
  assert.ok(transcriptPosts.length > 1);
  assert.ok(transcriptPosts.every((text) => text.length <= 1_900));
});
