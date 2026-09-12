import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscordVoiceMeetingSession,
  splitDiscordText,
} from "../src/discord-voice-session.mjs";

const noop = async () => undefined;
const meeting = (options = {}) =>
  new DiscordVoiceMeetingSession({
    logger: {},
    transcribe: noop,
    upsertLiveTranscript: noop,
    upsertMinutes: noop,
    archiveTranscript: noop,
    postText: noop,
    synthesize: noop,
    playAudio: noop,
    scheduleInterval: () => 0,
    cancelInterval: () => {},
    ...options,
  });

test("a partially delivered conversation answer resumes after restart without repeating analysis or sent chunks", async (t) => {
  let saved;
  let attempts = 0;
  const answer = Array.from(
    { length: 150 },
    (_, index) => `説明${index}: こちらが質問への回答です。`,
  ).join("\n");
  const chunks = splitDiscordText(answer);
  assert.ok(chunks.length > 1);
  const delivered = [];
  const original = meeting({
    checkpoint: async (value) => {
      saved = structuredClone(value);
    },
    observe: async () =>
      JSON.stringify({
        minutes: "質問に回答済み",
        shouldReply: true,
        reply: answer,
      }),
    postText: async (text) => {
      if (++attempts === 2) throw new Error("temporary Discord outage");
      delivered.push(text);
    },
  });
  t.after(() => original.stop());
  await original.addText("この案について説明して", { userId: "member" });
  await original.observeNow();
  assert.deepEqual(delivered, [chunks[0]]);
  const restored = meeting({
    initialState: saved,
    observe: async () => assert.fail("saved answer must not be regenerated"),
    controlTask: async () =>
      assert.fail("an answer cannot execute a task control"),
    postText: async (text) => delivered.push(text),
  });
  t.after(() => restored.stop());
  await restored.observeNow();
  await restored.observeNow();
  assert.deepEqual(delivered, chunks);
  assert.equal(restored.pendingControls.length, 0);
});

test("a conversation answer waits for a durable save and does not resend text after a speech failure", async (t) => {
  let saveFails = false;
  let observations = 0;
  const posts = [];
  const session = meeting({
    checkpoint: async () => {
      if (saveFails) throw new Error("disk unavailable");
    },
    observe: async () => {
      observations += 1;
      saveFails = true;
      return JSON.stringify({
        minutes: "回答を準備",
        shouldReply: true,
        reply: "こちらが回答です。",
      });
    },
    postText: async (text) => posts.push(text),
    synthesize: async () => {
      throw new Error("speech unavailable");
    },
  });
  t.after(() => session.stop());
  await session.addText("この案はどうですか", { userId: "member" });
  await session.observeNow();
  assert.deepEqual(posts, []);
  assert.equal(session.pendingControls.length, 1);
  saveFails = false;
  await session.observeNow();
  await session.observeNow();
  assert.equal(observations, 1);
  assert.deepEqual(posts, ["こちらが回答です。"]);
  assert.equal(session.pendingControls.length, 0);
});
