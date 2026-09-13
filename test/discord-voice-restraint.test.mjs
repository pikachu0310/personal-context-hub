import assert from "node:assert/strict";
import test from "node:test";
import {
  hasTaskCommitment,
  mayReplyImmediately,
  shouldDeliverObservationReply,
} from "../src/engine/observation/participation.mjs";
import { DiscordVoiceMeetingSession } from "../src/adapters/discord/sessions.mjs";
import {
  createDiscordDiscussionRouter,
  createThreadParticipantJoiner,
} from "../src/adapters/discord/discussion-threads.mjs";
import { createEditableDiscordPost } from "../src/adapters/discord/transport.mjs";

const statement = (text, sequence = 1) => ({
  text,
  sequence,
  userId: "123456789012345678",
  taskEligible: true,
});
const task = {
  title: "入力検証を追加",
  executionIntent: "requested",
  authorizationSequences: [1],
  sourceSequences: [1],
};

test("immediate participation requires a direct call, including when legacy unaddressed replies are enabled", () => {
  for (const text of [
    "それどうやるの？",
    "井戸Botの応答が多い",
    "『井戸Bot、調べて』と言った",
    "山田さん、調べて",
    "できるかな？",
  ])
    assert.equal(mayReplyImmediately(statement(text)), false, text);
  for (const text of [
    "井戸Bot、結果は？",
    "ねえ、井戸Bot、調べて",
    "Codex, 状態を教えて",
  ])
    assert.equal(mayReplyImmediately(statement(text)), true, text);
  assert.equal(
    mayReplyImmediately(
      { requestReply: true, taskEligible: false, text: "結果は？" },
      false,
    ),
    true,
  );
});

test("task evidence distinguishes actual commitment from speculation, quotes and later deferral", () => {
  for (const text of [
    "入力検証が足りない",
    "テスト整理してもらうか。",
    "あ、圧縮していいんじゃない。",
    "井戸Bot、テストを足してもいいかも",
    "井戸Bot、もし必要なら直して",
    "井戸Bot、まだ実行しなくていい",
    "「井戸Bot、修正して」と書いてある",
  ])
    assert.equal(
      hasTaskCommitment(task, [statement(text)], { autonomousTasks: true }),
      false,
      text,
    );
  assert.equal(
    hasTaskCommitment(task, [statement("井戸Bot、入力検証を追加して")]),
    true,
  );
  assert.equal(
    hasTaskCommitment(
      { ...task, executionIntent: "agreed" },
      [statement("入力検証はBotに任せよう。")],
      { autonomousTasks: true },
    ),
    true,
  );
  assert.equal(
    hasTaskCommitment({ ...task, sourceSequences: [1, 2] }, [
      statement("井戸Bot、入力検証を追加して"),
      statement("やっぱり今は保留にしよう", 2),
    ]),
    false,
  );
  assert.equal(
    hasTaskCommitment({ ...task, authorizationSequences: [99] }, [
      statement("井戸Bot、入力検証を追加して"),
    ]),
    false,
  );
});

test("a model cannot omit a later deferral from a task's evidence", () => {
  assert.equal(
    hasTaskCommitment(task, [
      statement("井戸Bot、入力検証を追加して"),
      statement("やっぱり今は保留にしよう", 2),
    ]),
    false,
  );
});

test("delayed responses allow new evidence but reject human questions, unsupported decisions and repeats", () => {
  const observation = {
    shouldReply: true,
    reply: "失敗原因は入力の空文字でした。",
    replyReason: "new_finding",
    replySourceSequences: [1],
  };
  const sources = [statement("入力検証の失敗原因がまだ不明です")];
  assert.equal(shouldDeliverObservationReply(observation, sources), true);
  assert.equal(
    shouldDeliverObservationReply(
      { ...observation, replyReason: "direct_answer" },
      sources,
    ),
    false,
  );
  assert.equal(
    shouldDeliverObservationReply(observation, sources, [
      { role: "assistant", text: observation.reply },
    ]),
    false,
  );
  assert.equal(
    shouldDeliverObservationReply(
      { ...observation, replySourceSequences: [99] },
      sources,
    ),
    false,
  );
});

test("ordinary speech waits for audit; uncertain tasks cannot start and verified findings are text only", async () => {
  const tasks = [],
    posted = [],
    spoken = [];
  let quick = 0,
    observations = 0;
  const session = new DiscordVoiceMeetingSession({
    ownerUserId: "owner",
    allParticipantsOperate: true,
    tasksEnabled: true,
    autonomousTasks: true,
    immediateReactions: true,
    answerUnaddressedQuestions: true,
    quickReply: async () => {
      quick++;
      return "余計な回答";
    },
    observe: async ({ statements }) => {
      observations++;
      return JSON.stringify({
        minutes: "入力検証は未決定",
        tasks: [
          {
            ...task,
            sourceSequences: [statements[0].sequence],
            authorizationSequences: [statements[0].sequence],
          },
        ],
        shouldReply: false,
      });
    },
    enqueueTask: async (task) => {
      tasks.push(task);
      return true;
    },
    postText: async (text) => posted.push(text),
    synthesize: async (text) => {
      spoken.push(text);
      return Buffer.alloc(0);
    },
    playAudio: async () => {},
    upsertMinutes: async () => {},
    upsertLiveTranscript: async () => {},
    scheduleInterval: () => ({}),
    cancelInterval: () => {},
    logger: { info() {} },
  });
  try {
    await session.addText("入力検証を追加したほうがいいかも", {
      userId: "guest",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(quick, 0);
    assert.equal(observations, 0);
    await session.observeNow();
    assert.deepEqual(tasks, []);
    assert.deepEqual(posted, []);
    session.dependencies.observe = async ({ statements }) =>
      JSON.stringify({
        minutes: "原因判明",
        tasks: [],
        shouldReply: true,
        reply: "保存済みのテスト結果では空文字を拒否できていません。",
        replyReason: "new_finding",
        replySourceSequences: [statements[0].sequence],
      });
    await session.addText("入力検証の結果が出た", { userId: "guest" });
    await session.observeNow();
    assert.equal(posted.length, 1);
    assert.deepEqual(spoken, []);
  } finally {
    await session.stop();
  }
});

test("discussion replies reuse one daily thread, join only real attributed participants, and restore after restart", async () => {
  const parent = [],
    replies = [],
    members = [];
  const thread = {
    id: "thread",
    parentId: "parent",
    ownerId: "bot",
    name: "会議の回答 2026-09-13",
    members: { add: async (id) => members.push(id) },
    send: async (payload) => replies.push(payload),
  };
  const textChannel = {
    id: "parent",
    threads: { fetchActive: async () => ({ threads: [] }) },
    send: async (payload) => {
      parent.push(payload);
      return { startThread: async () => thread };
    },
  };
  const options = {
    textChannel,
    botUserId: "bot",
    createMessagePayload: (content, opts) => ({ content, ...opts }),
    now: () => new Date("2026-09-13T00:00:00Z"),
  };
  const post = createDiscordDiscussionRouter(options);
  await Promise.all([
    post("回答1", {
      participantUserIds: ["123456789012345678", "@everyone", "model-made-id"],
      idempotencyKey: "reply-one",
    }),
    post("回答2", { participantUserIds: ["123456789012345678"] }),
  ]);
  assert.equal(parent.length, 1);
  assert.equal(replies.length, 2);
  assert.deepEqual(members, ["123456789012345678"]);
  assert.equal(replies[0].idempotencyKey, "reply-one");
  textChannel.threads.fetchActive = async () => ({ threads: [thread] });
  await createDiscordDiscussionRouter(options)("再起動後");
  assert.equal(parent.length, 1);
  assert.equal(replies.length, 3);
});

test("participant joining retries failures without repeating successful additions", async () => {
  let tries = 0;
  const join = createThreadParticipantJoiner();
  const thread = {
    id: "thread",
    members: {
      add: async () => {
        if (++tries === 1) throw new Error("temporary");
      },
    },
  };
  await join(thread, ["123456789012345678"]);
  await join(thread, ["123456789012345678"]);
  await join(thread, ["123456789012345678"]);
  assert.equal(tries, 2);
});

test("restart edits the existing bot status instead of creating another announcement", async () => {
  const edits = [];
  const message = {
    author: { id: "bot" },
    content: "🎙️ **井戸Bot・会議の案内**",
    edit: async (payload) => {
      edits.push(payload);
      return message;
    },
  };
  const update = createEditableDiscordPost(
    {
      messages: { fetch: async () => [message] },
      send: () => assert.fail("duplicate announcement"),
    },
    { botUserId: "bot", restorePrefix: "🎙️ **井戸Bot" },
  );
  await update("🎙️ **井戸Bot・会議の案内** 更新");
  assert.equal(edits.length, 1);
});
