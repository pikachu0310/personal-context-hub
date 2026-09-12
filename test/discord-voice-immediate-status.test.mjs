import assert from "node:assert/strict";
import test from "node:test";
import { DiscordVoiceMeetingSession } from "../src/discord-voice-session.mjs";
import { isImmediateTaskStatus } from "../src/discord-voice-intents.mjs";
const noop = async () => undefined;
const meeting = (options = {}) =>
  new DiscordVoiceMeetingSession({
    logger: {},
    transcribe: noop,
    upsertLiveTranscript: noop,
    upsertMinutes: noop,
    postText: noop,
    synthesize: noop,
    playAudio: noop,
    scheduleInterval: () => 0,
    cancelInterval: () => {},
    ...options,
  });

test("status intent accepts a clear addressed query and leaves broader questions to the observer", () => {
  assert.equal(isImmediateTaskStatus("井戸Bot、進捗を教えてください。"), true);
  assert.equal(
    isImmediateTaskStatus("作業状況は？", { explicitlyAsked: true }),
    true,
  );
  for (const text of [
    "作業状況は？",
    "井戸Bot、進捗の報告形式を実装して",
    "井戸Bot、作業状況を教えてから追加で実装して",
    "『井戸Bot、進捗を教えて』と聞きました",
  ])
    assert.equal(isImmediateTaskStatus(text), false);
});

test("participants can hear saved task status immediately without calling the observer or controlling tasks", async (t) => {
  let observations = 0,
    controls = 0;
  const posts = [],
    speech = [];
  const session = meeting({
    immediateReactions: true,
    ownerUserId: "owner",
    tasksEnabled: true,
    getTasks: () => [
      { id: "active01", title: "計算機を修正", state: "running" },
      { id: "waiting1", state: "queued" },
      { id: "failed01", state: "failed" },
    ],
    observe: async () => {
      observations++;
      return JSON.stringify({
        minutes: "context",
        tasks: [],
        shouldReply: false,
      });
    },
    controlTask: async () => {
      controls++;
    },
    postText: async (text) => posts.push(text),
    synthesize: async (text) => speech.push(text),
  });
  t.after(() => session.stop());
  await session.addText("井戸Bot、進捗を教えてください。", {
    userId: "member",
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(observations, 0);
  assert.equal(controls, 0);
  assert.ok(posts.some((text) => /実行中1件.*待機1件/.test(text)));
  assert.ok(posts.some((text) => text.includes("active01")));
  assert.ok(speech.some((text) => text.includes("失敗1件")));
  assert.equal(session.statements.at(-1).taskEligible, false);
  await session.addText("作業状況は？", {
    userId: "member",
    taskEligible: false,
    requestReply: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(observations, 0);
  assert.equal(posts.length, 2);
});

test("failed status delivery replays the saved answer once after restart without running a task", async (t) => {
  let saved;
  const original = meeting({
    getTasks: () => [{ id: "active01", state: "running" }],
    checkpoint: async (value) => {
      saved = structuredClone(value);
    },
    postText: async () => {
      throw new Error("offline");
    },
  });
  t.after(() => original.stop());
  await original.addText("井戸Bot、進捗を教えて", { userId: "member" });
  assert.equal(saved.pendingControls.length, 1);
  const posts = [];
  const restored = meeting({
    initialState: saved,
    postText: async (text) => posts.push(text),
    controlTask: async () =>
      assert.fail("read-only reply cannot control a task"),
    observe: async () =>
      JSON.stringify({ minutes: "context", tasks: [], shouldReply: false }),
  });
  t.after(() => restored.stop());
  await restored.observeNow();
  await restored.observeNow();
  assert.equal(posts.length, 1);
  assert.match(posts[0], /確認時点/);
  assert.equal(restored.pendingControls.length, 0);
});

test("status text arrives during an earlier spoken answer while speech remains in order", async (t) => {
  let release,
    played = 0;
  const posts = [],
    spoken = [];
  const session = meeting({
    getTasks: () => [{ id: "active01", state: "running" }],
    observe: async () =>
      JSON.stringify({
        minutes: "context",
        shouldReply: true,
        reply: "最初の回答です。",
      }),
    postText: async (text) => posts.push(text),
    synthesize: async (text) => {
      spoken.push(text);
      return Buffer.alloc(2);
    },
    playAudio: async () => {
      if (++played === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
    },
  });
  t.after(async () => {
    release?.();
    await session.stop();
  });
  await session.addText("案について説明して", { userId: "member" });
  const observation = session.observeNow();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const status = session.addText("井戸Bot、進捗を教えて", { userId: "member" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    posts.some((text) => text.includes("実行中1件")),
    "text status cannot wait for the previous audio to finish",
  );
  assert.deepEqual(spoken, ["最初の回答です。"]);
  release();
  await Promise.all([observation, status]);
  await session.speechQueue;
  assert.equal(played, 2);
  assert.match(spoken[1], /実行中1件/);
});

test("shutdown cancels queued speech without delaying delivered status text or carrying speech into a new meeting", async (t) => {
  let speaking = false,
    synthesized = 0;
  const posts = [];
  const session = meeting({
    getTasks: () => [{ id: "active01", state: "running" }],
    observe: async () => assert.fail("direct status must not invoke Codex"),
    postText: async (text) => posts.push(text),
    synthesize: async () => {
      synthesized++;
      return Buffer.alloc(2);
    },
    playAudio: async (_audio, { signal }) =>
      new Promise((_resolve, reject) => {
        speaking = true;
        if (signal.aborted) reject(signal.reason);
        else
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
      }),
  });
  t.after(() => session.stop());
  await session.addText("井戸Bot、進捗を教えて", { userId: "member" });
  while (!speaking) await new Promise((resolve) => setImmediate(resolve));
  await session.addText("井戸Bot、進捗を教えて", { userId: "member" });
  assert.equal(posts.length, 2);
  assert.equal(synthesized, 1);
  assert.equal(session.observing, false);
  assert.equal(await session.newMeeting(), false);
  await session.stop();
  assert.equal(synthesized, 1);
  assert.equal(session.pendingSpeechCount, 0);
});
