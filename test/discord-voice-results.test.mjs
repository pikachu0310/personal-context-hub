import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscordVoiceTaskQueue,
  DiscordVoiceMeetingSession,
} from "../src/discord-voice-session.mjs";
import { createIdobataMessageHandler } from "../src/discord-voice-commands.mjs";
const noop = async () => undefined;
const eventually = async (check) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};
const queue = (options = {}) =>
  new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: async () => ({ post: noop, update: noop }),
    runTask: async () => "result",
    ...options,
  });

test("a stop while completed work awaits instruction receipts remains cancelled", async (t) => {
  let release;
  const tasks = queue({
    runTask: async (task) => {
      task.instructionBarrier = new Promise((resolve) => {
        release = resolve;
      });
      return "work finished before stop";
    },
  });
  t.after(async () => {
    release?.();
    await tasks.stop();
  });
  await tasks.enqueueDurable({ id: "stopped1", title: "work" });
  await eventually(() => release);
  await tasks.handleVoiceControlDurable({ type: "stop", taskId: "stopped1" });
  release();
  await eventually(() => tasks.active === 0);
  assert.equal(tasks.list()[0].state, "cancelled");
});

test("a failed continuation cannot relabel the previous result with its new verification evidence", async (t) => {
  const tasks = queue({
    runTask: async (task) => {
      task.runRevision = (task.runRevision ?? 0) + 1;
      task.evidence = {
        runRevision: task.runRevision,
        tests: [
          {
            scope: "command_exit",
            outcome: task.runRevision === 1 ? "passed" : "failed",
          },
        ],
      };
      if (task.runRevision === 2) throw new Error("second run failed");
      return "first result";
    },
  });
  t.after(() => tasks.stop());
  await tasks.enqueueDurable({ id: "result01", title: "work" });
  await eventually(() => tasks.active === 0);
  await tasks.handleVoiceControlDurable({
    type: "instruction",
    taskId: "result01",
    instruction: "continue",
  });
  await eventually(() => tasks.active === 0);
  const result = tasks.getTaskResult("result01");
  assert.equal(result.result, "first result");
  assert.equal(result.runRevision, 1);
  assert.equal(result.currentRunRevision, 2);
  assert.equal(result.currentState, "failed");
  assert.match(result.verification, /成功 1件・失敗 0件/);
  const restored = queue();
  t.after(() => restored.stop());
  await restored.restore(tasks.snapshot(), async () => ({
    post: noop,
    update: noop,
  }));
  assert.deepEqual(restored.getTaskResult("result01"), result);
});

test("result command reads every saved result chunk without starting another worker", async () => {
  const posts = [];
  const result = "saved detail\n".repeat(500) + "last detail";
  const handler = createIdobataMessageHandler({
    config: {
      guildId: "guild",
      textChannelId: "channel",
      allowedUserId: "owner",
    },
    session: {},
    taskQueue: {
      getTaskResult: (id) =>
        id === "result01"
          ? {
              id,
              title: "work",
              result,
              runRevision: 1,
              currentRunRevision: 2,
              currentState: "failed",
              verification: "成功 1件",
            }
          : undefined,
    },
  });
  await handler({
    guildId: "guild",
    channelId: "channel",
    content: "!ido result result01",
    author: { id: "member" },
    channel: { send: async ({ content }) => posts.push(content) },
  });
  assert.match(posts.join("\n"), /実行版 1/);
  assert.match(posts.join("\n"), /現在.*失敗.*実行版 2/);
  assert.match(posts.at(-1), /last detail/);
  assert.ok(posts.every((text) => text.length <= 1950));
});

test("an explicitly named historical result joins bounded observation context without artifact internals", async (t) => {
  let context;
  const session = new DiscordVoiceMeetingSession({
    transcribe: noop,
    upsertLiveTranscript: noop,
    upsertMinutes: noop,
    postText: noop,
    synthesize: noop,
    playAudio: noop,
    scheduleInterval: () => 0,
    cancelInterval: () => {},
    logger: {},
    getTasks: () => [{ id: "oldtask1", title: "older work", state: "failed" }],
    getTaskResult: (id) =>
      id === "oldtask1"
        ? {
            id: "oldtask1",
            result: "saved older result",
            runRevision: 1,
            currentRunRevision: 2,
            currentState: "failed",
            verification: "成功 1件",
            artifacts: { secretInternal: "must not enter prompt" },
          }
        : undefined,
    initialState: {
      results: Array.from({ length: 20 }, (_, i) => ({
        id: `recent${i}`,
        result: "r".repeat(4000),
        artifacts: { secretInternal: "must not enter prompt" },
      })),
    },
    observe: async (value) => {
      context = value;
      return JSON.stringify({
        minutes: "context",
        shouldReply: false,
        tasks: [],
      });
    },
  });
  t.after(() => session.stop());
  await session.addText("oldtask1 の結果を教えて", { userId: "owner" });
  await session.observeNow();
  const old = context.results.find((result) => result.id === "oldtask1");
  assert.equal(old.result, "saved older result");
  assert.equal(old.runRevision, 1);
  assert.equal(old.currentState, "failed");
  assert.equal(context.results.length, 6);
  assert.ok(context.results.some((result) => result.id === "recent19"));
  assert.equal(
    JSON.stringify(context.results).includes("secretInternal"),
    false,
  );
});
