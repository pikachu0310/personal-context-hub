import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscordVoiceMeetingSession,
  DiscordVoiceTaskQueue,
} from "../src/adapters/discord/sessions.mjs";
import { createIdobataMessageHandler } from "../src/adapters/discord/commands.mjs";

const noop = async () => undefined;

test("cancelling a failed receipt prevents a delayed replay from starting it", async (t) => {
  let fail = true,
    runs = 0;
  const tasks = queue({
    checkpoint: async () => {
      if (fail) throw new Error("disk full");
    },
    runTask: async () => {
      runs++;
      return "unexpected";
    },
  });
  t.after(() => tasks.stop());
  const request = { id: "stableid", title: "work", requestKey: "voice:cancel" };
  await assert.rejects(tasks.enqueueDurable(request));
  await eventually(() => tasks.active === 0);
  const id = tasks.list()[0].id;
  const cancelled = await tasks.handleVoiceControlDurable({
    type: "stop",
    taskId: id,
  });
  assert.equal(cancelled.persisted, false);
  fail = false;
  await tasks.enqueueDurable(request);
  await eventually(() => tasks.active === 0);
  assert.equal(runs, 0);
  assert.equal(tasks.list().length, 1);
  assert.equal(tasks.list()[0].state, "cancelled");
  assert.equal(id, request.id);
});

test("a meeting request can be cancelled before any queue receipt exists and survives restart", async (t) => {
  let saved,
    attempts = 0;
  const original = meeting({
    checkpoint: async (value) => {
      saved = structuredClone(value);
    },
    enqueueTask: async () => {
      attempts++;
      throw new Error("unavailable");
    },
  });
  t.after(() => original.stop());
  await original.addText("井戸Bot、実装して", { userId: "owner" });
  await original.observeNow();
  const id = original.pendingTasks[0].id;
  assert.ok(id);
  assert.equal((await original.cancelPendingTask(id)).type, "cancelled");
  const restored = meeting({
    initialState: saved,
    enqueueTask: async () => {
      attempts++;
      return true;
    },
  });
  t.after(() => restored.stop());
  await restored.observeNow();
  assert.equal(attempts, 1);
  assert.equal(restored.pendingTasks.length, 0);
});
const eventually = async (check) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};
function queue(options = {}) {
  return new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: async (task) => ({
      threadId: task.id,
      post: noop,
      update: noop,
    }),
    runTask: async () => "completed",
    ...options,
  });
}
function meeting(options = {}) {
  return new DiscordVoiceMeetingSession({
    logger: {},
    ownerUserId: "owner",
    tasksEnabled: true,
    transcribe: noop,
    upsertLiveTranscript: noop,
    upsertMinutes: noop,
    postText: noop,
    synthesize: async () => Buffer.alloc(0),
    playAudio: noop,
    scheduleInterval: () => 0,
    cancelInterval: () => {},
    observe: async ({ statements }) =>
      JSON.stringify({
        minutes: "決定",
        tasks: [
          {
            title: "work",
            sourceSequences: [statements[0].sequence],
            authorizationSequences: [statements[0].sequence],
            executionIntent: "requested",
          },
        ],
        shouldReply: false,
      }),
    ...options,
  });
}

test("failed receipts retain their ID on retry and cannot overwrite another request", async (t) => {
  let fail = true,
    runs = 0;
  const tasks = queue({
    checkpoint: async () => {
      if (fail) throw new Error("disk full");
    },
    runTask: async () => {
      runs++;
      return "result";
    },
  });
  t.after(() => tasks.stop());
  const task = { id: "stable01", title: "work", requestKey: "voice:retry" };
  await assert.rejects(tasks.enqueueDurable(task));
  await eventually(() => tasks.active === 0);
  fail = false;
  await tasks.enqueueDurable({ ...task, id: undefined });
  await eventually(() => tasks.active === 0);
  assert.equal(runs, 1);
  assert.equal(tasks.list().length, 1);
  assert.equal(tasks.list()[0].id, task.id);
  await assert.rejects(
    tasks.enqueueDurable({ ...task, requestKey: "another" }),
    /already belongs/,
  );
});

test("resuming a failed receipt acknowledges the original request without replaying its initial work", async (t) => {
  let fail = true;
  const runs = [],
    saved = [];
  const tasks = queue({
    checkpoint: async (records) => {
      if (fail) throw new Error("disk full");
      saved.push(structuredClone(records));
    },
    runTask: async (task) => {
      runs.push(task.additionalInstruction ?? "initial");
      return "done";
    },
  });
  t.after(() => tasks.stop());
  const request = {
    id: "resume01",
    title: "work",
    requestKey: "voice:receipt-resume",
  };
  await assert.rejects(tasks.enqueueDurable(request));
  await eventually(() => tasks.active === 0);
  fail = false;
  await tasks.handleVoiceControlDurable({
    type: "instruction",
    taskId: request.id,
    instruction: "resume saved request",
    requestKey: "resume",
  });
  await eventually(() => tasks.active === 0);
  await tasks.enqueueDurable(request);
  await eventually(() => tasks.active === 0);
  assert.deepEqual(runs, ["resume saved request"]);
  const receipt = saved.find((records) => records[0].controlReceipts?.resume);
  assert.equal(receipt[0].receiptFailed, false);
  const restored = queue({
    runTask: async () => assert.fail("must not replay acknowledged work"),
  });
  t.after(() => restored.stop());
  await restored.restore(receipt, async () => ({ post: noop, update: noop }));
  assert.equal(await restored.enqueueDurable(request), true);
});

test("voice cancellation is resolved before replaying a pending receipt", async (t) => {
  let runs = 0,
    fail = true,
    saved;
  const tasks = queue({
    checkpoint: async () => {
      if (fail) throw new Error("disk full");
    },
    runTask: async () => {
      runs++;
      return "unexpected";
    },
  });
  t.after(() => tasks.stop());
  const session = meeting({
    checkpoint: async (value) => {
      saved = structuredClone(value);
    },
    enqueueTask: (task) => tasks.enqueueDurable(task),
    getTaskReceipt: (key) => tasks.getReceipt(key),
    getTasks: () => tasks.list(),
    controlTask: (control) => tasks.handleVoiceControlDurable(control),
    observe: async ({ statements, activeTasks }) =>
      JSON.stringify(
        statements[0].text.includes("停止")
          ? {
              minutes: "取り消し",
              tasks: [],
              taskControls: [
                {
                  type: "stop",
                  taskId: activeTasks[0].id,
                  sourceSequences: [statements[0].sequence],
                },
              ],
              shouldReply: false,
            }
          : {
              minutes: "作業依頼",
              tasks: [
                {
                  title: "work",
                  sourceSequences: [statements[0].sequence],
                  authorizationSequences: [statements[0].sequence],
                  executionIntent: "requested",
                },
              ],
              shouldReply: false,
            },
      ),
  });
  t.after(() => session.stop());
  await session.addText("井戸Bot、実装して", { userId: "owner" });
  await session.observeNow();
  await eventually(() => tasks.active === 0);
  fail = false;
  await session.addText("井戸Bot、停止して", { userId: "owner" });
  await session.observeNow();
  assert.equal(runs, 0);
  assert.equal(saved.pendingTasks.length, 0);
  assert.equal(tasks.list()[0].state, "cancelled");
});

test("text stop cancels a pending request during its blocked receipt write", async (t) => {
  let release,
    runs = 0,
    surfaces = 0;
  const tasks = queue({
    checkpoint: () =>
      new Promise((resolve) => {
        if (!release) release = resolve;
        else resolve();
      }),
    createTaskThread: async () => {
      surfaces++;
      return { post: noop, update: noop };
    },
    runTask: async () => {
      runs++;
      return "unexpected";
    },
  });
  const session = meeting({
    enqueueTask: (task) => tasks.enqueueDurable(task),
    getTaskReceipt: (key) => tasks.getReceipt(key),
    controlTask: (control) => tasks.handleVoiceControlDurable(control),
  });
  t.after(async () => {
    release?.();
    await session.stop();
    await tasks.stop();
  });
  await session.addText("井戸Bot、実装して", { userId: "owner" });
  const observation = session.observeNow();
  await eventually(() => release);
  const task = session.pendingTasks[0];
  const replies = [];
  const handler = createIdobataMessageHandler({
    config: { textChannelId: "channel", allowedUserId: "owner" },
    session,
    taskQueue: tasks,
  });
  const stopped = handler({
    id: "cancel-message",
    channelId: "channel",
    content: `!ido stop ${task.id}`,
    author: { id: "owner" },
    channel: { send: async (value) => replies.push(value.content) },
  });
  await eventually(() => task.cancelled);
  release();
  await Promise.all([observation, stopped]);
  await eventually(() => tasks.active === 0);
  assert.equal(runs, 0);
  assert.equal(surfaces, 0);
  assert.ok(replies.some((text) => text.includes("停止しました")));
});

test("a task cannot create its Discord surface or execute before its receipt is saved", async (t) => {
  let release,
    surfaces = 0,
    runs = 0;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const tasks = queue({
    checkpoint: () => blocked,
    createTaskThread: async (task) => {
      surfaces++;
      return { threadId: task.id, post: noop, update: noop };
    },
    runTask: async () => {
      runs++;
      return "result";
    },
  });
  t.after(async () => {
    release();
    await tasks.stop();
  });
  tasks.enqueue({ title: "work" });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(surfaces, 0);
  assert.equal(runs, 0);
  release();
  await eventually(() => runs === 1);
});

test("stop during the transition to running cannot launch a worker afterward", async (t) => {
  let release,
    runs = 0;
  const tasks = queue({
    checkpoint: async (records) => {
      if (records[0]?.state === "running" && !release)
        await new Promise((resolve) => {
          release = resolve;
        });
    },
    runTask: async () => {
      runs++;
      return "unexpected";
    },
  });
  t.after(async () => {
    release?.();
    await tasks.stop();
  });
  await tasks.enqueueDurable({ title: "work" });
  await eventually(() => release);
  const stopped = tasks.handleVoiceControlDurable({
    type: "stop",
    taskId: tasks.list()[0].id,
  });
  release();
  await stopped;
  await eventually(() => tasks.active === 0);
  assert.equal(runs, 0);
  assert.equal(tasks.list()[0].state, "cancelled");
});

test("a failed task receipt never starts Codex", async (t) => {
  let runs = 0;
  const tasks = queue({
    checkpoint: async () => {
      throw new Error("disk full");
    },
    runTask: async () => {
      runs++;
      return "result";
    },
  });
  t.after(() =>
    assert.rejects(tasks.stop(), { code: "TASK_STATE_SAVE_FAILED" }),
  );
  tasks.enqueue({ title: "work" });
  await eventually(() => tasks.active === 0);
  assert.equal(runs, 0);
  assert.equal(tasks.list()[0].state, "failed");
});

test("an instruction during receipt storage does not schedule the task twice", async (t) => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const calls = [];
  const tasks = queue({
    checkpoint: () => blocked,
    runTask: async (task) => {
      calls.push({
        request: task.request,
        additionalInstruction: task.additionalInstruction,
      });
      return "result";
    },
  });
  t.after(async () => {
    release();
    await tasks.stop();
  });
  tasks.enqueue({ title: "work", request: "initial request" });
  tasks.handleTaskMessage({
    taskId: tasks.list()[0].id,
    userId: "owner",
    ownerUserId: "owner",
    content: "additional requirement",
  });
  release();
  await eventually(() => tasks.active === 0);
  assert.deepEqual(calls, [
    {
      request: "initial request",
      additionalInstruction: "additional requirement",
    },
  ]);
});

test("a stuck receipt times out and a task can be cancelled before its thread exists", async (t) => {
  const stuck = queue({
    checkpointTimeoutMs: 10,
    checkpoint: () => new Promise(() => undefined),
  });
  t.after(() =>
    assert.rejects(stuck.stop(), { code: "TASK_STATE_SAVE_FAILED" }),
  );
  await assert.rejects(stuck.enqueueDurable({ title: "stuck" }), {
    code: "TASK_STATE_SAVE_FAILED",
  });
  let release,
    surfaces = 0;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const tasks = queue({
    checkpoint: () => blocked,
    createTaskThread: async () => {
      surfaces++;
    },
  });
  t.after(async () => {
    release();
    await tasks.stop();
  });
  tasks.enqueue({ title: "cancel before start" });
  const task = tasks.list()[0];
  assert.equal(
    tasks.handleTaskMessage({
      taskId: task.id,
      userId: "owner",
      ownerUserId: "owner",
      content: "停止",
    }).type,
    "cancelled",
  );
  release();
  await eventually(() => tasks.active === 0);
  assert.equal(surfaces, 0);
  assert.equal(tasks.list()[0].state, "cancelled");
});

test("the same persisted request cannot create a second task after restart", async (t) => {
  const tasks = queue();
  t.after(() => tasks.stop());
  tasks.enqueue({ title: "first", requestKey: "message:123" });
  tasks.enqueue({ title: "duplicate", requestKey: "message:123" });
  await eventually(() => tasks.active === 0);
  assert.equal(tasks.snapshot().length, 1);
  const restored = queue({
    runTask: async () => {
      assert.fail("must not rerun");
    },
  });
  t.after(() => restored.stop());
  await restored.restore(tasks.snapshot(), async (task) => ({
    threadId: task.id,
    post: noop,
    update: noop,
  }));
  assert.equal(
    await restored.enqueueDurable({
      title: "replayed",
      requestKey: "message:123",
    }),
    true,
  );
  assert.equal(restored.snapshot().length, 1);
});

test("a receipt saved before thread creation can be resumed explicitly after restart", async (t) => {
  let runs = 0;
  const tasks = queue({
    runTask: async () => {
      runs++;
      return "recovered";
    },
  });
  t.after(() => tasks.stop());
  await tasks.restore(
    [
      {
        id: "received",
        requestKey: "voice:1",
        request: "original",
        state: "queued",
      },
    ],
    async () => {
      throw new Error("thread was not created yet");
    },
  );
  assert.equal(runs, 0);
  assert.equal(
    tasks.handleTaskMessage({
      taskId: "received",
      userId: "owner",
      ownerUserId: "owner",
      content: "続けて",
    }).type,
    "instruction",
  );
  await eventually(() => runs === 1 && tasks.active === 0);
  assert.equal(tasks.list()[0].state, "completed");
  assert.equal(tasks.list()[0].threadId, "received");
});

test("a meeting task interrupted before dispatch survives with its original authorization and context", async (t) => {
  let saved;
  const original = meeting({
    checkpoint: async (value) => {
      saved = structuredClone(value);
    },
    enqueueTask: async () => {
      throw new Error("process interrupted");
    },
  });
  t.after(() => original.stop());
  await original.addText("井戸Bot、青いボタンを実装して", { userId: "owner" });
  await original.observeNow();
  assert.equal(saved.pendingTasks.length, 1);
  const started = [];
  const restored = meeting({
    initialState: saved,
    enqueueTask: async (task) => {
      started.push(task);
      return true;
    },
  });
  t.after(() => restored.stop());
  await restored.observeNow();
  await restored.observeNow();
  assert.equal(started.length, 1);
  assert.match(started[0].request, /青いボタン/);
  assert.match(started[0].context, /決定/);
  assert.ok(started[0].requestKey);
});

test("a crash after the task receipt but before the meeting acknowledgement cannot duplicate work", async (t) => {
  let savedMeeting,
    runs = 0;
  const tasks = queue({
    runTask: async () => {
      runs++;
      return "result";
    },
  });
  t.after(() => tasks.stop());
  const session = meeting({
    checkpoint: async (value) => {
      if (value.pendingTasks.length) savedMeeting = structuredClone(value);
      else if (savedMeeting)
        throw new Error("crash before clearing dispatch record");
    },
    enqueueTask: (task) => tasks.enqueueDurable(task),
  });
  t.after(() => session.stop().catch(() => undefined));
  await session.addText("井戸Bot、実装して", { userId: "owner" });
  await session.observeNow();
  await eventually(() => runs === 1 && tasks.active === 0);
  const restoredTasks = queue({
    runTask: async () => {
      runs++;
      return "duplicate";
    },
  });
  t.after(() => restoredTasks.stop());
  await restoredTasks.restore(tasks.snapshot(), async (task) => ({
    threadId: task.id,
    post: noop,
    update: noop,
  }));
  const restoredMeeting = meeting({
    initialState: savedMeeting,
    enqueueTask: (task) => restoredTasks.enqueueDurable(task),
  });
  t.after(() => restoredMeeting.stop());
  await restoredMeeting.observeNow();
  assert.equal(runs, 1);
  assert.equal(restoredTasks.snapshot().length, 1);
  assert.equal(restoredMeeting.pendingTasks.length, 0);
});

test("a capacity rejection stays rejected when its notice must be retried", async (t) => {
  let enqueueCalls = 0,
    posts = 0;
  const session = meeting({
    enqueueTask: async () => {
      enqueueCalls++;
      return enqueueCalls > 1;
    },
    postText: async () => {
      if (++posts === 1) throw new Error("post failed");
    },
  });
  t.after(() => session.stop());
  await session.addText("井戸Bot、実装して", { userId: "owner" });
  await session.observeNow();
  assert.equal(session.pendingTasks[0].rejectionReason, "queue_full");
  await session.observeNow();
  assert.equal(enqueueCalls, 1);
  assert.equal(session.pendingTasks.length, 0);
});
