import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscordVoiceMeetingSession,
  DiscordVoiceTaskQueue,
} from "../src/discord-voice-session.mjs";
const noop = async () => undefined;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function eventually(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await tick();
  }
  assert.fail("condition not reached");
}
function meeting(options = {}) {
  return new DiscordVoiceMeetingSession({
    logger: {},
    transcribe: noop,
    upsertLiveTranscript: noop,
    upsertMinutes: noop,
    postText: noop,
    synthesize: noop,
    playAudio: noop,
    scheduleInterval: () => 0,
    cancelInterval: () => {},
    ...options,
  });
}
function queue(options = {}) {
  return new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: async (task) => ({
      threadId: task.id,
      post: noop,
      update: noop,
    }),
    runTask: async () => "result",
    ...options,
  });
}

test("a task cannot resume in its worktree until the aborted worker has actually settled", async (t) => {
  let finishWorker,
    aborted = false,
    runs = 0;
  const tasks = queue({
    runTask: async (_task, { signal }) => {
      runs++;
      if (runs > 1) return "follow-up complete";
      await new Promise((resolve) => {
        finishWorker = resolve;
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
          },
          { once: true },
        );
      });
      return "late response";
    },
  });
  t.after(async () => {
    finishWorker?.();
    await tasks.stop();
  });
  await tasks.enqueueDurable({ title: "work" });
  await eventually(() => runs === 1);
  const id = tasks.list()[0].id;
  const stopping = tasks.handleTaskMessageDurable(follow(id, "停止"));
  await eventually(() => aborted);
  await tasks.handleTaskMessageDurable(follow(id, "別の修正へ進んで"));
  await tick();
  assert.equal(runs, 1);
  finishWorker();
  await stopping;
  await eventually(() => runs === 2 && tasks.active === 0);
});
const follow = (taskId, content) => ({
  taskId,
  userId: "owner",
  ownerUserId: "owner",
  content,
});

test("meeting shutdown waits for incoming text before closing its archive", async () => {
  let release,
    closed = false,
    archiveCalls = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const session = meeting({
    archiveTranscript: async () => {
      archiveCalls++;
      await pending;
    },
    closeTranscriptArchive: async () => {
      closed = true;
    },
  });
  const input = session.addText("受信済みの発言", { userId: "owner" });
  const stop = session.stop();
  try {
    await tick();
    assert.equal(closed, false);
    assert.equal(archiveCalls, 1);
  } finally {
    release();
    await input;
    await stop;
  }
  assert.equal(closed, true);
  assert.equal(session.statements[0].text, "受信済みの発言");
});

test("meeting shutdown waits for an in-flight observation checkpoint", async () => {
  let release,
    blocked = false,
    closed = false;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const session = meeting({
    observe: async () =>
      JSON.stringify({ minutes: "決定", shouldReply: false }),
    checkpoint: async (state) => {
      if (state.revision === 1 && !blocked) {
        blocked = true;
        await pending;
      }
    },
    closeTranscriptArchive: async () => {
      closed = true;
    },
  });
  await session.addText("決定を保存して", { userId: "owner" });
  const observation = session.observeNow();
  await eventually(() => blocked);
  const stop = session.stop();
  try {
    await tick();
    assert.equal(closed, false);
  } finally {
    release();
    await observation;
    await stop;
  }
  assert.equal(closed, true);
});

test("service shutdown preserves active and queued follow-ups for explicit resumption", async (t) => {
  let active = false;
  const tasks = queue({
    runTask: async (task, { signal }) => {
      if (!task.additionalInstruction) return "initial result";
      active = true;
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  t.after(() => tasks.stop());
  await tasks.enqueueDurable({ title: "work" });
  await eventually(() => tasks.active === 0);
  const id = tasks.list()[0].id;
  await tasks.handleTaskMessageDurable(follow(id, "青いボタンへ変更"));
  await eventually(() => active);
  await tasks.handleTaskMessageDurable(follow(id, "余白も調整"));
  await tasks.stop();
  const saved = tasks.snapshot();
  assert.equal(saved[0].state, "interrupted");
  assert.match(saved[0].instructions[0].text, /青いボタン/);
  assert.match(saved[0].instructions[0].text, /完了未確認/);
  assert.match(saved[0].instructions[1].text, /余白/);
  const calls = [];
  const restored = queue({
    runTask: async (task) => {
      calls.push(task.additionalInstruction);
      return "done";
    },
  });
  t.after(() => restored.stop());
  await restored.restore(saved, async () => ({
    threadId: "thread",
    post: noop,
    update: noop,
  }));
  assert.equal(calls.length, 0);
  await restored.handleTaskMessageDurable(follow(id, "再開"));
  await eventually(() => restored.active === 0);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /青いボタン/);
  assert.match(calls[1], /余白/);
});
