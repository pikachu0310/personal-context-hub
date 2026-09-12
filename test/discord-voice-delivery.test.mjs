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
