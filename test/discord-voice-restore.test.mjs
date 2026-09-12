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

test("a temporary thread lookup failure preserves a follow-up without creating another thread or starting Codex", async (t) => {
  let available = false,
    created = 0;
  const runs = [];
  const tasks = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: async () => {
      created++;
      return { threadId: "replacement", post: noop, update: noop };
    },
    runTask: async (task) => {
      runs.push(task.additionalInstruction);
      return "done";
    },
  });
  t.after(() => tasks.stop());
  await tasks.restore(
    [
      {
        id: "saved",
        state: "completed",
        threadId: "original",
        codexThreadId: "original-codex",
      },
    ],
    async () => {
      if (!available) throw new Error("temporary lookup outage");
      return { threadId: "original", post: noop, update: noop };
    },
  );
  await tasks.handleTaskMessageDurable({
    taskId: "saved",
    userId: "owner",
    ownerUserId: "owner",
    content: "preserved follow-up",
  });
  await eventually(() => tasks.active === 0);
  assert.equal(created, 0);
  assert.deepEqual(runs, []);
  assert.equal(tasks.snapshot()[0].instructions[0].text, "preserved follow-up");
  available = true;
  await tasks.handleTaskMessageDurable({
    taskId: "saved",
    userId: "owner",
    ownerUserId: "owner",
    content: "resume",
  });
  await eventually(() => tasks.active === 0);
  assert.equal(created, 0);
  assert.deepEqual(runs, ["preserved follow-up", "resume"]);
  assert.equal(tasks.list()[0].threadId, "original");
});

test("a confirmed deleted result thread is recreated to deliver saved results without rerunning work", async (t) => {
  let created = 0;
  const posts = [];
  const tasks = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: async () => {
      created++;
      return {
        threadId: "replacement",
        starterId: "new-card",
        post: async (text) => posts.push(text),
        update: noop,
      };
    },
    runTask: async () =>
      assert.fail("replacing a deleted result thread cannot rerun work"),
  });
  t.after(() => tasks.stop());
  await tasks.restore(
    [
      {
        id: "saved",
        state: "completed",
        result: "saved result",
        resultDeliveryPending: true,
        threadId: "deleted",
        starterId: "old-card",
        codexThreadId: "original-codex",
      },
    ],
    async () => {
      throw Object.assign(new Error("thread deleted"), {
        code: "TASK_SURFACE_MISSING",
      });
    },
  );
  await tasks.retryResultDelivery();
  assert.equal(created, 1);
  assert.ok(posts.includes("saved result"));
  const restored = tasks.snapshot()[0];
  assert.equal(restored.threadId, "replacement");
  assert.equal(restored.starterId, "new-card");
  assert.equal(restored.codexThreadId, "original-codex");
  assert.equal(restored.resultDeliveryPending, false);
});

test("stopping during a thread lookup prevents a late missing-thread response from creating a replacement", async (t) => {
  let release,
    created = 0;
  const tasks = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: async () => {
      created++;
      return { post: noop, update: noop };
    },
    runTask: async () => assert.fail("stopped task cannot run"),
  });
  t.after(() => tasks.stop());
  await tasks.restore(
    [{ id: "saved", state: "completed", threadId: "original" }],
    async () => {
      await new Promise((resolve) => {
        release = resolve;
      });
      throw Object.assign(new Error("deleted"), {
        code: "TASK_SURFACE_MISSING",
      });
    },
  );
  await tasks.handleTaskMessageDurable({
    taskId: "saved",
    userId: "owner",
    ownerUserId: "owner",
    content: "continue",
  });
  await eventually(() => release);
  await tasks.handleTaskMessageDurable({
    taskId: "saved",
    userId: "owner",
    ownerUserId: "owner",
    content: "stop",
  });
  release();
  await eventually(() => tasks.active === 0);
  assert.equal(created, 0);
  assert.equal(tasks.list()[0].state, "cancelled");
});
