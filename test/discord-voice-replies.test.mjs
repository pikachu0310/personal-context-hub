import assert from "node:assert/strict";
import test from "node:test";
import { createDiscordMessagePayload } from "../src/adapters/discord/transport.mjs";
import { DiscordVoiceMeetingSession } from "../src/adapters/discord/sessions.mjs";
import { splitDiscordText } from "../src/adapters/discord/presentation.mjs";

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

test("a second question is answered while the first answer is still playing, with speech kept in order", async (t) => {
  const posts = [],
    spoken = [],
    observations = [];
  let releaseSpeech;
  const heldSpeech = new Promise((resolve) => {
    releaseSpeech = resolve;
  });
  const session = meeting({
    observe: async ({ statements }) => {
      observations.push(statements.map((statement) => statement.text));
      return JSON.stringify({
        minutes: `会話${observations.length}`,
        shouldReply: true,
        reply: `回答${observations.length}`,
      });
    },
    postText: async (text) => posts.push(text),
    synthesize: async (text) => text,
    playAudio: async (text) => {
      spoken.push(text);
      if (spoken.length === 1) await heldSpeech;
    },
  });
  t.after(async () => {
    releaseSpeech();
    await session.stop();
  });
  const eventually = async (check) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail("next answer was blocked by the previous playback");
  };
  await session.addText("最初の質問", { userId: "member" });
  let observationCompleted = false;
  const first = session.observeNow().then(() => {
    observationCompleted = true;
  });
  await eventually(() => spoken.length === 1);
  await session.addText("次の質問", { userId: "member", requestReply: true });
  await eventually(() => posts.length === 2);
  assert.deepEqual(observations, [["最初の質問"], ["次の質問"]]);
  assert.deepEqual(posts, ["回答1", "回答2"]);
  assert.deepEqual(spoken, ["回答1"]);
  assert.equal(observationCompleted, false);
  releaseSpeech();
  await first;
  await session.speechQueue;
  assert.deepEqual(spoken, ["回答1", "回答2"]);
});

test(
  "a timed-out observation releases the next question without cancelling work or accepting a late answer",
  { timeout: 2000 },
  async (t) => {
    let releaseLateAnswer, firstSignal;
    let attempts = 0;
    const posts = [];
    const session = meeting({
      stageTimeouts: { observing: 10, running_codex: 10000 },
      getTasks: () => [{ id: "active-task", state: "running" }],
      controlTask: async () =>
        assert.fail("an observation timeout cannot stop background work"),
      observe: async (_input, { signal }) => {
        if (++attempts === 1) {
          firstSignal = signal;
          return new Promise((resolve) => {
            releaseLateAnswer = resolve;
          });
        }
        return JSON.stringify({
          minutes: "最新の確認",
          shouldReply: true,
          reply: "再試行後の回答",
        });
      },
      postText: async (text) => posts.push(text),
    });
    t.after(() => session.stop());
    await session.addText("質問です", { userId: "member" });
    assert.equal(await session.observeNow(), false);
    assert.equal(firstSignal.aborted, true);
    assert.equal(firstSignal.reason.code, "STAGE_TIMEOUT");
    assert.equal(session.statements.length, 1);
    assert.equal(session.observing, false);
    assert.equal(session.observationRetryPending, true);
    releaseLateAnswer(
      JSON.stringify({
        minutes: "古い確認",
        shouldReply: true,
        reply: "期限切れの回答",
      }),
    );
    assert.equal(await session.observeNow(), true);
    assert.deepEqual(posts, ["再試行後の回答"]);
    assert.equal(session.minutes, "最新の確認");
    assert.equal(session.getActiveTasks()[0].state, "running");
  },
);

test("a reply accepted by Discord but missing its acknowledgement reuses its delivery identity after restart", async (t) => {
  let saved;
  const received = new Map();
  const attempts = [];
  const postText = async (text, options) => {
    const payload = createDiscordMessagePayload(text, options);
    assert.equal(payload.enforceNonce, true);
    assert.match(payload.nonce, /^[a-f0-9]{24}$/);
    attempts.push(payload.nonce);
    if (received.has(payload.nonce)) return received.get(payload.nonce);
    received.set(payload.nonce, { id: "accepted-message", content: text });
    throw new Error("acknowledgement lost after Discord accepted the message");
  };
  const original = meeting({
    checkpoint: async (value) => {
      saved = structuredClone(value);
    },
    observe: async () =>
      JSON.stringify({
        minutes: "answer ready",
        shouldReply: true,
        reply: "保存する回答",
      }),
    postText,
  });
  t.after(() => original.stop());
  await original.addText("質問です", { userId: "member" });
  await original.observeNow();
  const restored = meeting({
    initialState: saved,
    postText,
    observe: async () => assert.fail("delivery retry cannot invoke Codex"),
  });
  t.after(() => restored.stop());
  await restored.observeNow();
  assert.equal(received.size, 1);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0], attempts[1]);
  assert.equal(restored.pendingControls.length, 0);
  assert.notEqual(
    createDiscordMessagePayload("another answer", {
      idempotencyKey: "different-request",
    }).nonce,
    attempts[0],
  );
  assert.equal(createDiscordMessagePayload("ordinary post").nonce, undefined);
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
  const deliveryKeys = [];
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
    postText: async (text, { idempotencyKey }) => {
      deliveryKeys.push(idempotencyKey);
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
    postText: async (text, { idempotencyKey }) => {
      deliveryKeys.push(idempotencyKey);
      delivered.push(text);
    },
  });
  t.after(() => restored.stop());
  await restored.observeNow();
  await restored.observeNow();
  assert.deepEqual(delivered, chunks);
  assert.notEqual(deliveryKeys[0], deliveryKeys[1]);
  assert.equal(deliveryKeys[1], deliveryKeys[2]);
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

test("a saved answer delivered after a meeting switch keeps its old context and chunk position", async (t) => {
  let saved;
  let attempts = 0;
  const answer = "旧議題への答えです。".repeat(220);
  const chunks = splitDiscordText(answer);
  const original = meeting({
    checkpoint: async (value) => {
      saved = structuredClone(value);
    },
    observe: async () =>
      JSON.stringify({
        minutes: "old decision",
        shouldReply: true,
        reply: answer,
      }),
    postText: async () => {
      if (++attempts > 1) throw new Error("offline");
    },
  });
  t.after(() => original.stop());
  await original.addText("以前の会議への質問", { userId: "member" });
  await original.observeNow();
  assert.equal(await original.newMeeting(), true);
  const delivered = [],
    spoken = [];
  const restored = meeting({
    initialState: saved,
    observe: async () =>
      assert.fail("old answer must not be analyzed as new speech"),
    postText: async (text) => delivered.push(text),
    synthesize: async (text) => spoken.push(text),
  });
  t.after(() => restored.stop());
  await restored.observeNow();
  assert.deepEqual(
    delivered,
    chunks.slice(1).map((chunk) => `↩️ **以前の会議への回答**\n${chunk}`),
  );
  assert.ok(delivered.every((text) => text.length <= 2000));
  assert.match(spoken[0], /^以前の会議への回答です。/);
  assert.equal(restored.minutes, "");
});
