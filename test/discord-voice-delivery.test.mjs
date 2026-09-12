import assert from "node:assert/strict";
import test from "node:test";
import { DiscordVoiceTaskQueue } from "../src/discord-voice-session.mjs";

const noop = async () => undefined;
const eventually = async (check) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};

test("a Discord result outage cannot discard accepted follow-up instructions", async (t) => {
  let release;
  const runs = [];
  const queue = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: async (task) => ({
      threadId: task.id,
      update: noop,
      post: async (content) => {
        if (content.includes("実行結果"))
          throw new Error("Discord unavailable");
      },
    }),
    runTask: async (task) => {
      runs.push(task.additionalInstruction ?? "initial");
      if (runs.length === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      return `result ${runs.length}`;
    },
  });
  t.after(async () => {
    release?.();
    await queue.stop();
  });
  queue.enqueue({ title: "work", request: "initial" });
  await eventually(() => release);
  const task = queue.list()[0];
  assert.equal(
    queue.handleTaskMessage({
      taskId: task.id,
      userId: "owner",
      ownerUserId: "owner",
      content: "追加の検証も実行",
    }).type,
    "instruction",
  );
  release();
  await eventually(() => runs.length === 2);
  assert.deepEqual(runs, ["initial", "追加の検証も実行"]);
});

test("restart retries missing result details and attachments without rerunning Codex", async (t) => {
  const posts = [],
    artifacts = [],
    results = [];
  let available = false,
    runCount = 0;
  const queue = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: async (task) => ({
      threadId: task.id,
      update: noop,
      post: async (content) => {
        if (!available && content.includes("実行結果"))
          throw new Error("Discord unavailable");
        posts.push(content);
      },
      postArtifacts: async (value) => artifacts.push(value),
    }),
    runTask: async (task) => {
      runCount++;
      task.artifacts = { patchPath: "/tmp/synthetic.patch" };
      return "verified detail";
    },
    onResult: async (value) => results.push(value),
  });
  t.after(() => queue.stop());
  queue.enqueue({ title: "work", request: "initial" });
  await eventually(() => queue.snapshot()[0].resultDeliveryPending);
  await eventually(() => !queue.tasks.values().next().value.executing);
  const saved = queue.snapshot();
  await queue.stop();
  available = true;
  const restored = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: noop,
    runTask: async () => {
      runCount++;
      return "unexpected rerun";
    },
    onResult: async (value) => results.push(value),
  });
  t.after(() => restored.stop());
  await restored.restore(saved, async (task) => ({
    threadId: task.id,
    update: noop,
    post: async (content) => posts.push(content),
    postArtifacts: async (value) => artifacts.push(value),
  }));
  await restored.retryResultDelivery();
  assert.equal(runCount, 1);
  assert.ok(posts.some((content) => content.includes("verified detail")));
  assert.equal(artifacts.length, 1);
  assert.equal(results.length, 1);
  assert.equal(restored.snapshot()[0].resultDeliveryPending, false);
});

test("an attachment retry resumes after delivered text and keeps each follow-up result", async (t) => {
  const posts = [],
    reports = [];
  let offline = true;
  const queue = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: async (task) => ({
      threadId: task.id,
      update: noop,
      post: async (content) => posts.push(content),
      postArtifacts: async () => {
        if (offline) throw new Error("upload unavailable");
      },
    }),
    runTask: async (task) => {
      task.artifacts = { patchPath: "synthetic" };
      return task.additionalInstruction ?? "first result";
    },
    onResult: async (result) => reports.push(result.result),
  });
  t.after(() => queue.stop());
  queue.enqueue({ title: "work" });
  await eventually(
    () =>
      queue.snapshot()[0].state === "completed" &&
      !queue.tasks.values().next().value.executing,
  );
  const task = queue.list()[0];
  queue.handleTaskMessage({
    taskId: task.id,
    userId: "owner",
    ownerUserId: "owner",
    content: "second result",
  });
  await eventually(
    () =>
      queue.snapshot()[0].result === "second result" &&
      !queue.tasks.values().next().value.executing,
  );
  offline = false;
  await Promise.all([queue.retryResultDelivery(), queue.retryResultDelivery()]);
  assert.equal(posts.filter((content) => content === "first result").length, 1);
  assert.equal(
    posts.filter((content) => content === "second result").length,
    1,
  );
  assert.deepEqual(reports, ["first result", "second result"]);
  assert.deepEqual(queue.snapshot()[0].resultDeliveries, []);
});
