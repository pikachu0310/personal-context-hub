import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DiscordVoiceTaskQueue } from "../src/discord-voice-session.mjs";
import { createDiscordArtifactPoster } from "../src/discord-voice-server.mjs";

const noop = async () => undefined;
const eventually = async (check) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};

test("a stalled result upload releases the worker slot and retains both revisions across shutdown", async (t) => {
  let releaseWorker, releaseUpload;
  const runs = [],
    posts = [],
    reports = [],
    uploaded = [],
    cards = [];
  let saved;
  const queue = new DiscordVoiceTaskQueue({
    logger: {},
    concurrency: 1,
    postText: noop,
    checkpoint: async (value) => {
      saved = structuredClone(value);
    },
    createTaskThread: async (task) => ({
      threadId: task.id,
      update: noop,
      post: async (content) => posts.push(content),
      postArtifacts: async () => {
        if (task.id === "first")
          await new Promise((resolve) => {
            releaseUpload = resolve;
          });
      },
    }),
    runTask: async (task) => {
      task.runRevision = (task.runRevision ?? 0) + 1;
      runs.push(`${task.id}:${task.runRevision}`);
      if (runs.length === 1)
        await new Promise((resolve) => {
          releaseWorker = resolve;
        });
      task.artifacts = {
        runRevision: task.runRevision,
        patchPath: `${task.id}-r${task.runRevision}.patch`,
      };
      task.evidence = { runRevision: task.runRevision };
      return `${task.id} result r${task.runRevision}`;
    },
    onResult: async (result) => reports.push(result),
  });
  t.after(async () => {
    releaseWorker?.();
    releaseUpload?.();
    await queue.stop();
  });
  queue.enqueue({ id: "first", title: "first" });
  await eventually(() => releaseWorker);
  queue.enqueue({ id: "second", title: "second" });
  await queue.handleTaskMessageDurable({
    taskId: "first",
    userId: "owner",
    ownerUserId: "owner",
    content: "follow up",
  });
  releaseWorker();
  await eventually(
    () =>
      releaseUpload &&
      runs.length === 3 &&
      queue.active === 0 &&
      reports.length === 1,
  );
  assert.deepEqual(runs, ["first:1", "second:1", "first:2"]);
  assert.equal(reports[0].id, "second");
  assert.equal(queue.tasks.get("first").executing, false);
  assert.deepEqual(
    queue
      .snapshot()[0]
      .resultDeliveries.map((delivery) => delivery.artifacts.patchPath),
    ["first-r1.patch", "first-r2.patch"],
  );

  // Shutdown aborts the delivery wait and checkpoints its unacknowledged stage.
  await queue.stop();
  assert.equal(queue.deliveries.size, 0);
  assert.equal(saved[0].state, "completed");
  assert.equal(saved[0].resultDeliveries[0].nextStep, 3);
  const restored = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: noop,
    runTask: async () => assert.fail("retry must not run a worker"),
    onResult: async (result) => reports.push(result),
  });
  t.after(() => restored.stop());
  await restored.restore(saved, async () => ({
    threadId: "first",
    post: async (content) => posts.push(content),
    update: async (options) => {
      if (options.isCurrent) cards.push(options);
    },
    postArtifacts: async (artifacts, evidence) =>
      uploaded.push({ artifacts, evidence }),
  }));
  await restored.retryResultDelivery();
  assert.deepEqual(
    uploaded.map(({ artifacts, evidence }) => [
      artifacts.patchPath,
      evidence.runRevision,
    ]),
    [
      ["first-r1.patch", 1],
      ["first-r2.patch", 2],
    ],
  );
  assert.deepEqual(
    reports.map((result) => [result.id, result.runRevision]),
    [
      ["second", 1],
      ["first", 1],
      ["first", 2],
    ],
  );
  assert.equal(
    posts.filter((content) => content === "first result r1").length,
    1,
  );
  assert.equal(
    cards.length,
    1,
    "the old delivery must not refresh the latest card",
  );
  assert.equal(cards[0].state, "completed");
  assert.equal(cards[0].isCurrent(), true);
  restored.tasks.get("first").state = "running";
  assert.equal(
    cards[0].isCurrent(),
    false,
    "a queued edit must expire when work resumes",
  );
  assert.equal(restored.snapshot()[0].resultDeliveryPending, false);
});

test("a stalled restored result cannot block another task's result retry", async (t) => {
  let release;
  const reports = [];
  const queue = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: noop,
    runTask: noop,
    onResult: async (result) => reports.push(result.id),
  });
  t.after(async () => {
    release?.();
    await queue.stop();
  });
  await queue.restore(
    ["first", "second"].map((id) => ({
      id,
      title: id,
      state: "completed",
      result: id,
      resultDeliveryPending: true,
    })),
    async (task) => ({
      threadId: task.id,
      update: noop,
      post: async (content) => {
        if (task.id === "first" && content.includes("実行結果"))
          await new Promise((resolve) => {
            release = resolve;
          });
      },
    }),
  );
  const retry = queue.retryResultDelivery();
  await eventually(() => release && reports.includes("second"));
  assert.deepEqual(reports, ["second"]);
  release();
  await retry;
  assert.deepEqual(reports, ["second", "first"]);
});

test("artifact retries retain their Discord identity while a new result revision gets a distinct identity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ido-artifact-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const patchPath = join(root, "result.patch");
  await writeFile(patchPath, "+synthetic change\n");
  const payloads = [];
  const post = createDiscordArtifactPoster(
    { send: async (payload) => payloads.push(payload) },
    { id: "task01" },
  );
  await post(
    { patchPath, runRevision: 1 },
    {},
    { idempotencyKey: "result-one:artifacts" },
  );
  await post(
    { patchPath, runRevision: 1 },
    {},
    { idempotencyKey: "result-one:artifacts" },
  );
  await post(
    { patchPath, runRevision: 2 },
    {},
    { idempotencyKey: "result-two:artifacts" },
  );
  assert.equal(payloads[0].nonce, payloads[1].nonce);
  assert.notEqual(payloads[0].nonce, payloads[2].nonce);
  assert.ok(
    payloads.every(
      (payload) => payload.enforceNonce && payload.files.length === 2,
    ),
  );
  assert.equal(payloads[2].files[0].name, "task01-r2.patch");
  assert.equal(
    payloads[2].files[0].attachment.toString(),
    "+synthetic change\n",
  );
  await writeFile(patchPath, "");
  await post(
    { patchPath, runRevision: 3, hasChanges: false },
    { tests: [{ outcome: "passed" }] },
    { idempotencyKey: "result-three:artifacts" },
  );
  assert.match(payloads[3].content, /変更差分はありません/);
  assert.doesNotMatch(payloads[3].content, /ido apply/);
  assert.equal(payloads[3].files.length, 1);
  assert.equal(payloads[3].files[0].name, "task01-r3-verification.json");
  assert.deepEqual(JSON.parse(payloads[3].files[0].attachment), {
    tests: [{ outcome: "passed" }],
  });
});

test("a task result keeps its delivery identities across a lost acknowledgement and restart", async (t) => {
  const accepted = new Map();
  const attempts = [];
  const post = async (content, { idempotencyKey } = {}) => {
    if (!idempotencyKey) return;
    attempts.push(idempotencyKey);
    if (accepted.has(idempotencyKey)) return;
    accepted.set(idempotencyKey, content);
    if (content.includes("実行結果") && attempts.length === 1)
      throw new Error("ack lost after server accepted result header");
  };
  const attachments = [],
    reports = [];
  const surface = () => ({
    threadId: "thread",
    post,
    update: noop,
    postArtifacts: async (_artifacts, _evidence, options) =>
      attachments.push(options.idempotencyKey),
  });
  const queue = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: surface,
    runTask: async (task) => {
      task.artifacts = { patchPath: "synthetic" };
      return "saved result";
    },
  });
  t.after(() => queue.stop());
  queue.enqueue({ title: "work" });
  await eventually(
    () => queue.snapshot()[0].resultDeliveryPending && queue.active === 0,
  );
  const saved = queue.snapshot();
  const deliveryId = saved[0].resultDeliveries[0].id;
  assert.ok(deliveryId);
  await queue.stop();
  const restored = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: surface,
    runTask: async () => assert.fail("result retry must not run Codex"),
    onResult: async (_result, options) => reports.push(options.idempotencyKey),
  });
  t.after(() => restored.stop());
  await restored.restore(saved, surface);
  await restored.retryResultDelivery();
  assert.equal(attempts[0], attempts[1]);
  assert.equal(
    [...accepted.values()].filter((text) => text.includes("実行結果")).length,
    1,
  );
  assert.equal(attachments.length, 1);
  assert.equal(reports.length, 1);
  const keys = [...accepted.keys(), ...attachments, ...reports];
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.every((key) => key.includes(deliveryId)));
  assert.equal(restored.snapshot()[0].resultDeliveryPending, false);
});

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
