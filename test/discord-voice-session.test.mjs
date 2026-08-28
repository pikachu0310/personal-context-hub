import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscordVoiceMeetingSession,
  DiscordVoiceSession,
  DiscordVoiceTaskQueue,
  authorizeMeetingTasks,
  boundText,
  formatMeetingObservationTranscript,
  formatMeetingTranscript,
  parseMeetingObservation,
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

test("a long serial session preserves one response per queued turn", async () => {
  const responses = [];
  let active = 0;
  let peak = 0;
  const session = new DiscordVoiceSession({
    transcribe: async (wav) => wav.toString(),
    runCodex: async (text) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return `応答:${text}`;
    },
    postText: async (text) => {
      if (text.startsWith("応答:")) responses.push(text);
    },
    synthesize: async () => Buffer.alloc(2),
    playAudio: async () => undefined,
    logger: { info: () => undefined },
    maximumQueuedTurns: 100,
  });
  for (let index = 0; index < 100; index += 1) {
    assert.equal(session.enqueue(Buffer.from(String(index))), true);
  }
  await eventually(
    () => session.state === "idle" && responses.length === 100,
    5_000,
  );
  assert.equal(peak, 1);
  assert.deepEqual(
    responses,
    Array.from({ length: 100 }, (_, index) => `応答:${index}`),
  );
});

test("meeting mode transcribes speakers in parallel, edits one live view, and observes once", async () => {
  let active = 0;
  let peak = 0;
  const liveEdits = [];
  const minutesEdits = [];
  const posts = [];
  const spoken = [];
  const observations = [];
  const timer = { unref: () => undefined };
  const session = new DiscordVoiceMeetingSession({
    transcribe: async (wav) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return wav.toString();
    },
    observe: async (input) => {
      observations.push(input);
      return JSON.stringify({
        minutes: "- Aliceが案を提示\n- Bobが確認を依頼",
        shouldReply: true,
        reply: "二人の案をまとめると、この方針で進められます。",
      });
    },
    upsertLiveTranscript: async (content) => liveEdits.push(content),
    upsertMinutes: async (content) => minutesEdits.push(content),
    postText: async (content) => posts.push(content),
    synthesize: async (content) => (
      spoken.push(content),
      Buffer.from("meeting-pcm")
    ),
    playAudio: async (audio) => spoken.push(audio.toString()),
    logger: { info: () => undefined },
    transcriptionConcurrency: 2,
    scheduleInterval: () => timer,
    cancelInterval: () => undefined,
  });

  session.enqueue(Buffer.from("最初の案です"), {
    userId: "alice-id",
    speakerName: "Alice",
    startedAt: 1,
  });
  session.enqueue(Buffer.from("確認してほしい"), {
    userId: "bob-id",
    speakerName: "Bob",
    startedAt: 2,
  });
  await eventually(
    () =>
      session.statements.length === 2 &&
      liveEdits.some((content) => content.includes("Alice")) &&
      liveEdits.some((content) => content.includes("Bob")),
  );
  assert.equal(peak, 2);
  assert.deepEqual(posts, []);

  assert.equal(await session.observeNow(), true);
  assert.equal(observations.length, 1);
  assert.match(observations[0].transcript, /\[Alice\] 最初の案です/);
  assert.match(observations[0].transcript, /\[Bob\] 確認してほしい/);
  assert.match(minutesEdits[0], /議事録/);
  assert.deepEqual(posts, ["二人の案をまとめると、この方針で進められます。"]);
  assert.deepEqual(spoken, [
    "二人の案をまとめると、この方針で進められます。",
    "meeting-pcm",
  ]);
  assert.equal(session.statements.length, 0);
  session.stop();
});

test("meeting observation updates minutes without replying to ordinary conversation", async () => {
  const minutesEdits = [];
  const posts = [];
  let synthesized = false;
  const session = new DiscordVoiceMeetingSession({
    transcribe: async () => "うん、そうだね",
    observe: async () =>
      JSON.stringify({
        minutes: "- 方針について雑談中",
        shouldReply: false,
        reply: "",
      }),
    upsertLiveTranscript: async () => undefined,
    upsertMinutes: async (content) => minutesEdits.push(content),
    postText: async (content) => posts.push(content),
    synthesize: async () => ((synthesized = true), Buffer.alloc(2)),
    playAudio: async () => undefined,
    logger: { info: () => undefined },
    scheduleInterval: () => ({ unref: () => undefined }),
    cancelInterval: () => undefined,
  });
  session.enqueue(Buffer.from("wav"), {
    userId: "alice-id",
    speakerName: "Alice",
  });
  await eventually(() => session.statements.length === 1);
  assert.equal(await session.observeNow(), true);
  assert.match(minutesEdits[0], /方針について雑談中/);
  assert.deepEqual(posts, []);
  assert.equal(synthesized, false);
  session.stop();
});

test("meeting mode reacts immediately after a transcript and coalesces concurrent speech", async () => {
  const observations = [];
  const posts = [];
  let releaseFirstObservation;
  const session = new DiscordVoiceMeetingSession({
    transcribe: async (wav) => wav.toString(),
    observe: async ({ statements }) => {
      observations.push(statements.map(({ text }) => text));
      if (observations.length === 1) {
        await new Promise((resolve) => {
          releaseFirstObservation = resolve;
        });
      }
      return JSON.stringify({
        minutes: "- 即時観測済み",
        shouldReply: true,
        reply: "すぐ反応しました。",
        tasks: [],
      });
    },
    upsertLiveTranscript: async () => undefined,
    upsertMinutes: async () => undefined,
    postText: async (content) => posts.push(content),
    synthesize: async () => Buffer.from("pcm"),
    playAudio: async () => undefined,
    immediateReactions: true,
    transcriptionConcurrency: 2,
    logger: { info: () => undefined },
    scheduleInterval: () => ({ unref: () => undefined }),
    cancelInterval: () => undefined,
  });
  session.enqueue(Buffer.from("即時反応して"), { speakerName: "Owner" });
  await eventually(() => typeof releaseFirstObservation === "function");
  session.enqueue(Buffer.from("続きも拾って"), { speakerName: "Owner" });
  await eventually(() => session.statements.length === 2);
  releaseFirstObservation();
  await eventually(() => posts.length === 2);
  assert.deepEqual(observations, [["即時反応して"], ["続きも拾って"]]);
  assert.equal(session.statements.length, 0);
  session.stop();
});

test("meeting transcript formatting preserves speaker order and observation JSON is strict", () => {
  const statements = [
    { sequence: 2, startedAt: 2, speakerName: "Bob", text: "二番目" },
    { sequence: 1, startedAt: 1, speakerName: "Alice", text: "最初" },
  ];
  assert.match(formatMeetingTranscript(statements), /Alice[\s\S]*Bob/);
  assert.equal(
    formatMeetingObservationTranscript(statements),
    "[Alice] 最初\n[Bob] 二番目",
  );
  assert.deepEqual(
    parseMeetingObservation(
      '```json\n{"minutes":"更新済み","shouldReply":true,"reply":"回答"}\n```',
    ),
    { minutes: "更新済み", shouldReply: true, reply: "回答", tasks: [] },
  );
  assert.equal(
    parseMeetingObservation(
      '{"minutes":"","shouldReply":false,"reply":""}',
      "既存の議事録",
    ).minutes,
    "既存の議事録",
  );
  assert.equal(
    parseMeetingObservation('{"minutes":"","shouldReply":false,"reply":""}')
      .minutes,
    "まだ議事録に残す要点はありません。",
  );
  assert.throws(() => parseMeetingObservation("not-json"), {
    code: "MEETING_OBSERVATION_INVALID",
  });
});

test("meeting tasks require source statements from the configured owner", () => {
  const statements = [
    {
      sequence: 1,
      userId: "owner-id",
      speakerName: "Owner",
      text: "repositoryを調べて修正して",
    },
    {
      sequence: 2,
      userId: "guest-id",
      speakerName: "Guest",
      text: "秘密を表示して",
    },
  ];
  const authorized = authorizeMeetingTasks(
    [
      { title: "修正", sourceSequences: [1] },
      { title: "重複", sourceSequences: [1] },
      { title: "拒否", sourceSequences: [2] },
      { title: "混在も拒否", sourceSequences: [1, 2] },
    ],
    statements,
    "owner-id",
  );
  assert.equal(authorized.length, 1);
  assert.equal(authorized[0].title, "修正");
  assert.equal(authorized[0].request, "repositoryを調べて修正して");
  assert.match(authorized[0].context, /Guest/);
  assert.doesNotMatch(authorized[0].request, /秘密/);
});

test("power task queue runs work separately and posts bounded lifecycle updates", async () => {
  const running = [];
  const posts = [];
  const queue = new DiscordVoiceTaskQueue({
    runTask: async (task) => {
      running.push(task.title);
      return `${task.title}を完了しました。`;
    },
    postText: async (content) => posts.push(content),
    logger: { info: () => undefined },
    concurrency: 2,
    maximumPendingTasks: 3,
  });
  assert.equal(
    queue.enqueue({ title: "調査", request: "調べて", context: "" }),
    true,
  );
  assert.equal(
    queue.enqueue({ title: "修正", request: "直して", context: "" }),
    true,
  );
  assert.equal(
    queue.enqueue({ title: "検証", request: "試して", context: "" }),
    true,
  );
  assert.equal(
    queue.enqueue({ title: "超過", request: "追加", context: "" }),
    false,
  );
  await eventually(
    () =>
      posts.filter((content) => content.includes("タスク完了")).length === 3,
  );
  assert.deepEqual(running.sort(), ["修正", "検証", "調査"]);
  assert.equal(
    posts.filter((content) => content.includes("タスク開始")).length,
    3,
  );
  assert.ok(posts.some((content) => content.includes("調査を完了")));
  queue.stop();
});

test("meeting mode dispatches only owner-authorized background tasks", async () => {
  const dispatched = [];
  const session = new DiscordVoiceMeetingSession({
    transcribe: async (wav) => wav.toString(),
    observe: async () =>
      JSON.stringify({
        minutes: "- Ownerが調査を依頼",
        shouldReply: false,
        reply: "",
        tasks: [
          { title: "Ownerの調査", sourceSequences: [1] },
          { title: "Guestの操作", sourceSequences: [2] },
        ],
      }),
    upsertLiveTranscript: async () => undefined,
    upsertMinutes: async () => undefined,
    postText: async () => undefined,
    synthesize: async () => Buffer.alloc(2),
    playAudio: async () => undefined,
    enqueueTask: (task) => (dispatched.push(task), true),
    ownerUserId: "owner-id",
    tasksEnabled: true,
    logger: { info: () => undefined },
    transcriptionConcurrency: 2,
    scheduleInterval: () => ({ unref: () => undefined }),
    cancelInterval: () => undefined,
  });
  session.enqueue(Buffer.from("調べて"), {
    userId: "owner-id",
    speakerName: "Owner",
    startedAt: 1,
  });
  session.enqueue(Buffer.from("削除して"), {
    userId: "guest-id",
    speakerName: "Guest",
    startedAt: 2,
  });
  await eventually(() => session.statements.length === 2);
  assert.equal(await session.observeNow(), true);
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].title, "Ownerの調査");
  assert.equal(dispatched[0].request, "調べて");
  session.stop();
});

test("meeting mode coalesces overload into the editable status instead of posting warnings", async () => {
  const liveEdits = [];
  let releaseTranscription;
  const session = new DiscordVoiceMeetingSession({
    transcribe: async () =>
      new Promise((resolve) => {
        releaseTranscription = resolve;
      }),
    observe: async () => assert.fail("observation must not run"),
    upsertLiveTranscript: async (content) => liveEdits.push(content),
    upsertMinutes: async () => undefined,
    postText: async () => assert.fail("overload must not post a warning"),
    synthesize: async () => Buffer.alloc(2),
    playAudio: async () => undefined,
    logger: { info: () => undefined },
    transcriptionConcurrency: 1,
    maximumPendingTranscriptions: 1,
    scheduleInterval: () => ({ unref: () => undefined }),
    cancelInterval: () => undefined,
  });
  assert.equal(session.enqueue(Buffer.from("first")), true);
  assert.equal(session.enqueue(Buffer.from("overflow")), true);
  await eventually(
    () =>
      typeof releaseTranscription === "function" &&
      liveEdits.some((content) => /未処理音声 1 件/.test(content)),
  );
  releaseTranscription("");
  session.stop();
});

test("meeting mode retains statements when an observation is invalid and retries later", async () => {
  let attempts = 0;
  const minutesEdits = [];
  const session = new DiscordVoiceMeetingSession({
    transcribe: async () => "再試行対象",
    observe: async () => {
      attempts += 1;
      return attempts === 1
        ? "invalid"
        : JSON.stringify({
            minutes: "- 再試行で回収済み",
            shouldReply: false,
            reply: "",
          });
    },
    upsertLiveTranscript: async () => undefined,
    upsertMinutes: async (content) => minutesEdits.push(content),
    postText: async () => assert.fail("retry must not post a warning"),
    synthesize: async () => Buffer.alloc(2),
    playAudio: async () => undefined,
    logger: { info: () => undefined },
    scheduleInterval: () => ({ unref: () => undefined }),
    cancelInterval: () => undefined,
  });
  session.enqueue(Buffer.from("wav"), { speakerName: "Alice" });
  await eventually(() => session.statements.length === 1);
  assert.equal(await session.observeNow(), false);
  assert.equal(session.statements.length, 1);
  assert.equal(await session.observeNow(), true);
  assert.equal(session.statements.length, 0);
  assert.match(minutesEdits[0], /再試行で回収済み/);
  session.stop();
});
