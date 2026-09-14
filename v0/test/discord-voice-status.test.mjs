import assert from "node:assert/strict";
import test from "node:test";
import { createIdobataMessageHandler } from "../src/adapters/discord/commands.mjs";
import { DiscordVoiceMeetingSession } from "../src/adapters/discord/sessions.mjs";

function handlerFor(tasks, session = {}) {
  const posts = [];
  const handler = createIdobataMessageHandler({
    config: {
      guildId: "guild",
      textChannelId: "channel",
      allowedUserId: "owner",
    },
    session,
    taskQueue: { list: () => tasks },
  });
  return {
    posts,
    send: (content) =>
      handler({
        guildId: "guild",
        channelId: "channel",
        content,
        author: { id: "owner" },
        channel: { send: async (value) => posts.push(value.content) },
      }),
  };
}

test("status shows pending and active tasks ahead of a long completed history", async () => {
  const tasks = Array.from({ length: 100 }, (_, i) => ({
    id: `old${String(i).padStart(5, "0")}`,
    title: `完了した作業${i}`,
    state: "completed",
    createdAt: i,
  }));
  tasks.push(
    {
      id: "undelivered1",
      title: "結果未送信",
      state: "completed",
      createdAt: -1,
      resultDeliveryPending: true,
    },
    { id: "running1", title: "現在の作業", state: "running", createdAt: 101 },
    { id: "pending1", title: "受付待ち", state: "failed", createdAt: 102 },
  );
  const { send, posts } = handlerFor(tasks, {
    pendingTasks: [{ id: "pending1", title: "受付待ち" }],
  });
  await send("!ido status");
  assert.match(posts[0], /running1/);
  assert.match(posts[0], /pending1.*受付保存/);
  assert.match(posts[0], /undelivered1.*完了（結果送信待ち）/);
  assert.equal(posts[0].split("pending1").length - 1, 1);
  assert.ok(posts[0].length <= 1950);
  assert.match(posts[0], /status 2/);
});

test("every status row remains reachable through bounded pages", async () => {
  const tasks = Array.from({ length: 35 }, (_, i) => ({
    id: `task${String(i).padStart(4, "0")}`,
    title: "長い作業名\n".repeat(50),
    state: "completed",
    createdAt: i,
  }));
  const { send, posts } = handlerFor(tasks);
  await send("/ido status");
  const pages = Number(posts[0].match(/1\/(\d+)ページ/u)?.[1]);
  assert.ok(pages > 1);
  for (let page = 2; page <= pages; page++) await send(`/ido status ${page}`);
  for (const task of tasks)
    assert.equal(posts.filter((text) => text.includes(task.id)).length, 1);
  assert.ok(posts.every((text) => text.length <= 1950));
  await send(`/ido status ${pages + 1}`);
  assert.match(posts.at(-1), /ページ番号/);
  await send("/ido status -1");
  assert.match(posts.at(-1), /ページ番号/);
});

test("meeting observation bounds historical tasks while retaining active and explicitly named work", async (t) => {
  const tasks = Array.from({ length: 1000 }, (_, i) => ({
    id: `task${String(i).padStart(4, "0")}`,
    title: `過去の作業${i}`,
    state: "completed",
    createdAt: i,
  }));
  tasks.push({
    id: "running1",
    title: "現在の作業",
    state: "running",
    createdAt: 1001,
  });
  let context;
  const noop = async () => undefined;
  const session = new DiscordVoiceMeetingSession({
    transcribe: noop,
    upsertLiveTranscript: noop,
    upsertMinutes: noop,
    postText: noop,
    synthesize: noop,
    playAudio: noop,
    getTasks: () => tasks,
    observe: async (value) => {
      context = value;
      return JSON.stringify({ minutes: "状況", tasks: [], shouldReply: false });
    },
    scheduleInterval: () => 0,
    cancelInterval: () => {},
    logger: {},
  });
  t.after(() => session.stop());
  await session.addText("task0003 の結果はどうだった？", { userId: "owner" });
  await session.observeNow();
  assert.ok(context.activeTasks.length <= 20);
  assert.ok(context.activeTasks.some((task) => task.id === "running1"));
  assert.ok(context.activeTasks.some((task) => task.id === "task0003"));
  assert.ok(context.activeTasks.some((task) => task.id === "task0999"));
  assert.equal(context.taskListSummary.total, 1001);
  assert.equal(context.taskListSummary.active, 1);
  assert.equal(
    context.taskListSummary.omitted,
    1001 - context.activeTasks.length,
  );
});
