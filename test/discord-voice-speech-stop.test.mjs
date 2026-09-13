import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscordVoiceMeetingSession,
  DiscordVoiceTaskQueue,
} from "../src/adapters/discord/sessions.mjs";
import { isImmediateSpeechStop } from "../src/engine/observation/intents.mjs";
import { createIdobataMessageHandler } from "../src/adapters/discord/commands.mjs";
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
    ownerUserId: "owner",
    scheduleInterval: () => 0,
    cancelInterval: () => {},
    ...options,
  });
const eventually = async (check) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};

test("speech stop recognizes a complete addressed instruction without capturing task stops or quotations", () => {
  assert.equal(
    isImmediateSpeechStop("井戸Bot、読み上げを止めてください。"),
    true,
  );
  assert.equal(isImmediateSpeechStop("Codex、現在の読み上げを停止して"), true);
  for (const text of [
    "読み上げを止めて",
    "井戸Bot、今の作業を止めて",
    "『井戸Bot、読み上げを止めて』と言いました",
    "井戸Bot、読み上げを止めるとどうなる？",
    "井戸Bot、読み上げを止めてからタスクを停止して",
  ])
    assert.equal(isImmediateSpeechStop(text), false, text);
});

test("an authorized speech stop cancels current and queued audio, preserves background work, and permits a new reply", async (t) => {
  let workerSignal,
    speakingSignal,
    synthesized = 0,
    played = 0;
  const tasks = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: async () => ({ post: noop, update: noop }),
    runTask: async (_task, { signal }) => {
      workerSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  const session = meeting({
    getTasks: () => tasks.list(),
    controlTask: async () =>
      assert.fail("speech stop cannot control background work"),
    synthesize: async () => {
      synthesized++;
      return Buffer.alloc(2);
    },
    playAudio: async (_audio, { signal }) => {
      if (++played > 1) return;
      speakingSignal = signal;
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  t.after(async () => {
    await tasks.stop();
    await session.stop();
  });
  await tasks.enqueueDurable({ title: "active work" });
  await eventually(() => workerSignal);
  await session.addText("井戸Bot、進捗を教えて", { userId: "member" });
  await eventually(() => speakingSignal);
  await session.addText("井戸Bot、進捗を教えて", { userId: "member" });
  await session.addText("井戸Bot、読み上げを止めて", { userId: "member" });
  await session.addText("井戸Bot、読み上げを止めて", {
    userId: "owner",
    taskEligible: false,
  });
  assert.equal(speakingSignal.aborted, false);
  await session.addText("井戸Bot、読み上げを止めて", { userId: "owner" });
  await session.speechQueue;
  assert.equal(speakingSignal.aborted, true);
  assert.equal(synthesized, 1);
  assert.equal(played, 1);
  assert.equal(workerSignal.aborted, false);
  assert.equal(tasks.list()[0].state, "running");
  await session.addText("井戸Bot、進捗を教えて", { userId: "member" });
  await session.speechQueue;
  assert.equal(synthesized, 2);
  assert.equal(played, 2);
});

test("an answer still being generated when speech is stopped is delivered as text, and a later question may speak", async (t) => {
  let release,
    observations = 0;
  const posts = [],
    spoken = [];
  const session = meeting({
    observe: async (_input, { signal }) => {
      if (++observations === 1) {
        await new Promise((resolve) => {
          release = resolve;
        });
        assert.equal(signal.aborted, false);
      }
      return JSON.stringify({
        minutes: "context",
        shouldReply: true,
        reply: `回答${observations}`,
      });
    },
    postText: async (text) => posts.push(text),
    synthesize: async (text) => spoken.push(text),
  });
  t.after(async () => {
    release?.();
    await session.stop();
  });
  await session.addText("最初の質問", { userId: "owner", taskEligible: false });
  const observation = session.observeNow();
  await eventually(() => release);
  await session.addText("井戸Bot、読み上げを止めて", { userId: "owner" });
  release();
  await observation;
  assert.ok(posts.includes("回答1"));
  assert.deepEqual(spoken, []);
  await session.addText("次の質問", { userId: "owner", taskEligible: false });
  await session.observeNow();
  assert.deepEqual(spoken, ["回答2"]);
});

test("silencing a saved undelivered reply survives restart and resets at a new meeting", async (t) => {
  let saved;
  const original = meeting({
    checkpoint: async (value) => {
      saved = structuredClone(value);
    },
    observe: async () =>
      JSON.stringify({
        minutes: "context",
        shouldReply: true,
        reply: "保存済みの回答",
      }),
    postText: async () => {
      throw new Error("offline");
    },
  });
  t.after(() => original.stop());
  await original.addText("質問", { userId: "owner" });
  await original.observeNow();
  await original.silenceSpeech();
  const posts = [],
    spoken = [];
  const restored = meeting({
    initialState: saved,
    observe: async () =>
      JSON.stringify({
        minutes: "new context",
        shouldReply: true,
        reply: "新しい会議の回答",
      }),
    postText: async (text) => posts.push(text),
    synthesize: async (text) => spoken.push(text),
  });
  t.after(() => restored.stop());
  await restored.observeNow();
  assert.deepEqual(posts, ["保存済みの回答"]);
  assert.deepEqual(spoken, []);
  assert.equal(await restored.newMeeting(), true);
  await restored.addText("新しい質問", { userId: "owner" });
  await restored.observeNow();
  assert.deepEqual(spoken, ["新しい会議の回答"]);
});

test("the quiet text command requires an operator and works without background task mode", async () => {
  let stops = 0;
  const posts = [];
  const handler = createIdobataMessageHandler({
    config: {
      guildId: "g",
      textChannelId: "c",
      allowedUserId: "owner",
      operatorUserIds: ["operator"],
    },
    session: {
      silenceSpeech: async () => {
        stops++;
        return { count: 1, persisted: true };
      },
    },
  });
  const send = (id) =>
    handler({
      id,
      guildId: "g",
      channelId: "c",
      author: { id },
      content: "!ido quiet",
      channel: { send: async (payload) => posts.push(payload.content) },
    });
  await send("member");
  assert.equal(stops, 0);
  await send("operator");
  assert.equal(stops, 1);
  assert.match(posts.at(-1), /読み上げを停止/);
});

test("a failed quiet checkpoint is retried during an idle observation without generating another answer", async (t) => {
  let offline = true,
    saved;
  const session = meeting({
    checkpoint: async (value) => {
      if (offline) throw new Error("disk unavailable");
      saved = structuredClone(value);
    },
    observe: async () =>
      assert.fail("retrying the speech-stop checkpoint must not invoke Codex"),
  });
  t.after(() => session.stop());
  assert.equal((await session.silenceSpeech()).persisted, false);
  assert.equal(saved, undefined);
  offline = false;
  await session.observeNow();
  assert.equal(saved.silencedThroughSequence, 0);
  assert.equal(session.speechStopSavePending, false);
});
