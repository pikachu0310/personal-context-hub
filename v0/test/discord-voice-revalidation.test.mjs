import assert from "node:assert/strict";
import test from "node:test";
import { createSpeechTicket } from "../src/engine/reply/speech-ticket.mjs";
import { parseRevalidation } from "../src/engine/reply/policy.mjs";
import { createOpenAIAudioAdapter } from "../src/providers/openai-audio.mjs";
import { DiscordVoiceMeetingSession } from "../src/adapters/discord/sessions.mjs";

const until = async (check) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Timed out");
};

test("a context update during validation invalidates keep and cancels resolved speech", async () => {
  const state = { revision: 1, pendingTranscripts: 0, conversation: [] };
  let release,
    calls = 0;
  const ticket = createSpeechTicket({
    getState: () => state,
    targets: [],
    text: "answer",
    validate: async () => {
      calls++;
      if (calls === 1) await new Promise((r) => (release = r));
      return { decision: calls === 1 ? "keep" : "cancel" };
    },
  });
  const ready = ticket.beforeStart();
  await until(() => release);
  state.revision++;
  release();
  assert.equal(await ready, false);
  assert.equal(calls, 2);
  assert.equal(ticket.canStart(), false);
});
test("STT must settle before validation; a later update revokes playback admission", async () => {
  const state = { revision: 1, pendingTranscripts: 1, conversation: [] };
  let calls = 0;
  const ticket = createSpeechTicket({
    getState: () => state,
    targets: [],
    text: "answer",
    validate: async () => {
      calls++;
      return { decision: "keep" };
    },
  });
  const ready = ticket.beforeStart();
  assert.equal(calls, 0);
  state.pendingTranscripts = 0;
  assert.equal(await ready, true);
  assert.equal(ticket.canStart(), true);
  state.revision++;
  assert.equal(ticket.canStart(), false);
  assert.equal(await ticket.beforeStart(), true);
  assert.equal(calls, 2);
});
test("expiry, supersession and unknown never admit speech", async () => {
  let now = 0,
    current = true;
  const state = { revision: 1, pendingTranscripts: 0, conversation: [] };
  const ticket = createSpeechTicket({
    getState: () => state,
    targets: [],
    text: "answer",
    now: () => now,
    ttlMs: 20,
    isCurrent: () => current,
  });
  assert.equal(await ticket.beforeStart(), true);
  now = 21;
  assert.equal(ticket.canStart(), false);
  assert.equal(await ticket.beforeStart(), false);
  now = 0;
  current = false;
  assert.equal(await ticket.beforeStart(), false);
  const unknown = createSpeechTicket({
    getState: () => state,
    targets: [],
    text: "answer",
    validate: async () => ({ decision: "unknown" }),
  });
  assert.equal(await unknown.beforeStart(), false);
});
test("cancellation evidence must refer to a later human statement, never the pending answer", () => {
  const conversation = [
    { role: "user", sequence: 1 },
    { role: "assistant", sequence: 4 },
    { role: "user", sequence: 5 },
  ];
  for (const sequence of [1, 4, 9])
    assert.throws(() =>
      parseRevalidation(
        { decision: "cancel", evidenceSequences: [sequence] },
        conversation,
        [{ sequence: 2 }],
      ),
    );
  assert.equal(
    parseRevalidation(
      { decision: "cancel", evidenceSequences: [5] },
      conversation,
      [{ sequence: 2 }],
    ).decision,
    "cancel",
  );
});
test("provider uses structured tool-free decisions and validates cancellation evidence", async () => {
  const requests = [];
  const responses = [
    { decision: "reply" },
    { decision: "cancel", evidenceSequences: [3] },
  ];
  const adapter = createOpenAIAudioAdapter(
    { quickReplyModel: "test-model" },
    {
      client: {
        responses: {
          create: async (request) => {
            requests.push(request);
            return { output_text: JSON.stringify(responses.shift()) };
          },
        },
      },
    },
  );
  assert.deepEqual(await adapter.classifyVoiceNeed({ text: "質問" }), {
    decision: "reply",
  });
  assert.equal(
    (
      await adapter.revalidateReply({
        targets: [{ sequence: 1 }],
        conversation: [{ role: "user", sequence: 3 }],
        pendingReply: "回答",
      })
    ).decision,
    "cancel",
  );
  assert.ok(
    requests.every(
      (r) => r.store === false && !r.tools && r.text.format.strict,
    ),
  );
});
function fixture(extra = {}) {
  const spoken = [],
    posts = [];
  const session = new DiscordVoiceMeetingSession({
    transcribe: async (b) => b.toString(),
    observe: async () => JSON.stringify({ minutes: "", shouldReply: false }),
    upsertLiveTranscript: async () => {},
    upsertMinutes: async () => {},
    postText: async (text) => posts.push(text),
    synthesize: async () => Buffer.alloc(1),
    playAudio: async () => spoken.push("played"),
    immediateReactions: true,
    answerUnaddressedQuestions: true,
    scheduleInterval: () => ({}),
    cancelInterval: () => {},
    logger: { info() {} },
    ...extra,
  });
  return { session, spoken, posts };
}
test("reply preparation is cancelled when a human resolves it during synthesis", async () => {
  let synthesizing = false,
    release;
  const seen = [];
  const { session, spoken, posts } = fixture({
    classifyVoiceNeed: async ({ text }) => ({
      decision: text === "井戸Bot、質問" ? "reply" : "pass",
    }),
    quickReply: async () => ({ action: "reply", reply: "生成した回答" }),
    synthesize: async () => {
      synthesizing = true;
      await new Promise((r) => (release = r));
      return Buffer.alloc(1);
    },
    revalidateReply: async (input) => {
      seen.push(input);
      return {
        decision: input.conversation.some((e) => e.text === "解決した")
          ? "cancel"
          : "keep",
      };
    },
  });
  try {
    await session.addText("井戸Bot、質問", { userId: "a" });
    await until(() => synthesizing);
    await session.addText("解決した", { userId: "b" });
    release();
    await until(() => session.pendingSpeechCount === 0);
    assert.deepEqual(spoken, []);
    assert.ok(posts.includes("生成した回答"));
    assert.equal(seen.length, 1);
    assert.ok(!seen[0].conversation.some((e) => e.text === "生成した回答"));
  } finally {
    await session.stop();
  }
});
test("semantic voice pass leaves the statement available for independent task planning", async () => {
  const { session, spoken } = fixture({
    autonomousTasks: true,
    classifyVoiceNeed: async () => ({ decision: "pass" }),
    quickReply: async () => assert.fail("must not generate an answer"),
  });
  try {
    await session.addText("井戸Bot、ここを速くできそう", { userId: "a" });
    await until(() => session.activeQuickReplies === 0);
    assert.deepEqual(spoken, []);
    const user = session.recentConversation.find((e) => e.role === "user");
    assert.equal(user.text, "井戸Bot、ここを速くできそう");
  } finally {
    await session.stop();
  }
});

test("already delivered task results are considered for voice once without reposting text", async () => {
  const { session, spoken, posts } = fixture({
    revalidateReply: async () => ({ decision: "keep" }),
  });
  const result = {
    id: "task",
    runRevision: 1,
    title: "検証",
    result: "検証が完了しました。",
  };
  try {
    await session.addTaskResult(result, { resultAlreadyDelivered: true });
    await session.speechQueue;
    await session.addTaskResult(result, { resultAlreadyDelivered: true });
    await session.speechQueue;
    assert.equal(spoken.length, 1);
    assert.deepEqual(posts, []);
  } finally {
    await session.stop();
  }
});

test("same pending question uses the latest candidate even when an older generation finishes late", async () => {
  let release;
  const answers = [];
  let generated = 0;
  const { session } = fixture({
    quickReply: async () => {
      const call = ++generated;
      if (call === 1) await new Promise((r) => (release = r));
      return { action: "reply", reply: `回答${call}` };
    },
    revalidateReply: async () => ({ decision: "keep" }),
    synthesize: async (text) => Buffer.from(text),
    playAudio: async (audio) => answers.push(audio.toString()),
  });
  try {
    await session.addText("井戸Bot、選択肢は？", { userId: "a" });
    await until(() => release);
    await session.addText("井戸Bot、選択肢は？", { userId: "b" });
    await until(() => answers.length === 1);
    release();
    await until(() => session.activeQuickReplies === 0);
    await session.speechQueue;
    assert.deepEqual(answers, ["回答2"]);
  } finally {
    release?.();
    await session.stop();
  }
});

test("a result superseded while synthesizing never plays before the new revision", async () => {
  let release,
    started = false;
  const played = [];
  const { session } = fixture({
    revalidateReply: async () => ({ decision: "keep" }),
    synthesize: async (text) => {
      if (text === "古い結果") {
        started = true;
        await new Promise((r) => (release = r));
      }
      return Buffer.from(text);
    },
    playAudio: async (audio) => played.push(audio.toString()),
  });
  try {
    await session.addTaskResult(
      { id: "task", title: "同じ作業", runRevision: 1, result: "古い結果" },
      { resultAlreadyDelivered: true },
    );
    await until(() => started);
    await session.addTaskResult(
      {
        id: "task",
        title: "訂正された作業名",
        runRevision: 2,
        result: "新しい結果",
      },
      { resultAlreadyDelivered: true },
    );
    release();
    await session.speechQueue;
    assert.deepEqual(played, ["新しい結果"]);
  } finally {
    release?.();
    await session.stop();
  }
});
