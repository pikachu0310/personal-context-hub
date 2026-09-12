import assert from "node:assert/strict";
import test from "node:test";
import { DiscordVoiceTaskQueue } from "../src/discord-voice-session.mjs";
const noop = async () => undefined;
const eventually = async (check) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};

test("completed history restores without Discord reads and its original thread can resume on demand", async (t) => {
  const loaded = [],
    resumed = [];
  let created = 0;
  const tasks = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: async () => {
      created++;
      return { post: noop, update: noop };
    },
    runTask: async (task) => {
      resumed.push({ id: task.id, codexThreadId: task.codexThreadId });
      return "continued";
    },
  });
  t.after(() => tasks.stop());
  const records = Array.from({ length: 1000 }, (_, i) => ({
    id: `task${i}`,
    state: "completed",
    title: `work${i}`,
    threadId: `discord${i}`,
    starterId: `starter${i}`,
    codexThreadId: `codex${i}`,
  }));
  await tasks.restore(records, async (task) => {
    loaded.push(task.id);
    return {
      threadId: task.threadId,
      starterId: task.starterId,
      post: noop,
      update: noop,
    };
  });
  assert.equal(loaded.length, 0);
  assert.equal(tasks.list()[3].threadId, "discord3");
  assert.equal(
    (
      await tasks.handleThreadMessageDurable({
        threadId: "discord3",
        userId: "owner",
        ownerUserId: "owner",
        content: "continue",
      })
    ).type,
    "instruction",
  );
  await eventually(() => tasks.active === 0);
  assert.deepEqual(loaded, ["task3"]);
  assert.deepEqual(resumed, [{ id: "task3", codexThreadId: "codex3" }]);
  assert.equal(created, 0);
});

test("interrupted tasks and undelivered results refresh during restoration, finished cards wait until apply", async (t) => {
  const loaded = [],
    updated = [];
  const tasks = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    runTask: noop,
    createTaskThread: noop,
    applyTask: async () => true,
  });
  t.after(() => tasks.stop());
  await tasks.restore(
    [
      { id: "interrupted", state: "running", threadId: "thread1" },
      {
        id: "delivery",
        state: "completed",
        threadId: "thread2",
        result: "saved",
        resultDeliveryPending: true,
      },
      {
        id: "finished",
        state: "completed",
        threadId: "thread3",
        artifacts: { runRevision: 1 },
      },
    ],
    async (task) => {
      loaded.push(task.id);
      return {
        threadId: task.threadId,
        post: noop,
        update: async () => updated.push(task.id),
      };
    },
  );
  assert.deepEqual(loaded, ["interrupted", "delivery"]);
  assert.equal(await tasks.applyTask("finished", 1), true);
  assert.deepEqual(loaded, ["interrupted", "delivery", "finished"]);
  assert.ok(updated.includes("finished"));
});

test("a temporary restore outage does not leave saved results stuck until another restart", async (t) => {
  let available = false;
  const posts = [];
  const tasks = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    runTask: async () => assert.fail("must not rerun saved work"),
    createTaskThread: noop,
  });
  t.after(() => tasks.stop());
  await tasks.restore(
    [
      {
        id: "saved",
        state: "completed",
        threadId: "thread",
        result: "saved result",
        resultDeliveryPending: true,
      },
    ],
    async () => {
      if (!available) throw new Error("temporary outage");
      return {
        threadId: "thread",
        update: noop,
        post: async (text) => posts.push(text),
      };
    },
  );
  available = true;
  await tasks.retryResultDelivery();
  assert.ok(posts.some((text) => text.includes("saved result")));
  assert.equal(tasks.snapshot()[0].resultDeliveryPending, false);
});
