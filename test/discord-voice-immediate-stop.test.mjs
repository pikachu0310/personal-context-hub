import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscordVoiceMeetingSession,
  DiscordVoiceTaskQueue,
} from "../src/discord-voice-session.mjs";
import { parseImmediateTaskStop } from "../src/discord-voice-intents.mjs";
import { serializeAudioPlayback } from "../src/discord-voice-server.mjs";
const noop = async () => undefined;
const eventually = async (check) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};

test("immediate stop accepts only complete direct stop phrases", () => {
  assert.deepEqual(
    parseImmediateTaskStop("井戸Bot、タスク ab12cd34 を停止してください。"),
    { taskId: "ab12cd34" },
  );
  assert.deepEqual(
    parseImmediateTaskStop("井戸ボット、今の作業を止めて。"),
    {},
  );
  for (const text of [
    "井戸Bot、停止するとどうなる？",
    "『井戸Bot、止めて』と発言しました",
    "停止してください",
    "井戸Bot、タスク ab12cd34 を停止してから再開して",
    "井戸Bot、stop と言った場合は？",
  ])
    assert.equal(parseImmediateTaskStop(text), undefined, text);
});

test("a stop acknowledgement queues behind existing speech and cancelling it cannot stop that speech", async () => {
  let release;
  const started = [];
  const play = serializeAudioPlayback(async (value) => {
    started.push(value);
    if (value === "first")
      await new Promise((resolve) => {
        release = resolve;
      });
  });
  const first = play("first");
  await eventually(() => release);
  const controller = new AbortController();
  const second = assert.rejects(
    play("cancelled acknowledgement", { signal: controller.signal }),
    /cancelled/,
  );
  controller.abort(new Error("cancelled"));
  assert.deepEqual(started, ["first"]);
  release();
  await first;
  await second;
  await play("next acknowledgement");
  assert.deepEqual(started, ["first", "next acknowledgement"]);
});

test("a completed authorized stop bypasses an occupied observer and invalidates its older instruction", async (t) => {
  let workerSignal,
    releaseObservation,
    observations = 0,
    runs = 0;
  const tasks = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: async () => ({ post: noop, update: noop }),
    runTask: async (_task, { signal }) => {
      runs++;
      workerSignal = signal;
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
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
    ownerUserId: "owner",
    tasksEnabled: true,
    getTasks: () => tasks.list(),
    controlTask: (control) => tasks.handleVoiceControlDurable(control),
    observe: async ({ statements }) => {
      observations++;
      await new Promise((resolve) => {
        releaseObservation = resolve;
      });
      return JSON.stringify({
        minutes: "context",
        tasks: [],
        shouldReply: false,
        taskControls: [
          {
            type: "instruction",
            taskId: "active01",
            instruction: "older instruction",
            sourceSequences: [statements[0].sequence],
          },
        ],
      });
    },
  });
  t.after(async () => {
    releaseObservation?.();
    await tasks.stop();
    await session.stop();
  });
  await tasks.enqueueDurable({ id: "active01", title: "work" });
  await eventually(() => workerSignal);
  await session.addText("井戸Bot、現在の作業にテストを追加して", {
    userId: "owner",
  });
  const observation = session.observeNow();
  await eventually(() => releaseObservation);
  await session.addText("井戸Bot、今の作業を止めて。", { userId: "owner" });
  assert.equal(workerSignal.aborted, true);
  assert.equal(tasks.list()[0].state, "cancelled");
  assert.equal(observations, 1);
  releaseObservation();
  await observation;
  await eventually(() => tasks.active === 0);
  assert.equal(runs, 1);
  assert.equal(tasks.list()[0].state, "cancelled");
});

test("unauthorized, incomplete, or ambiguous stop requests do not take the immediate path", async (t) => {
  const controls = [];
  const session = new DiscordVoiceMeetingSession({
    transcribe: noop,
    observe: noop,
    upsertLiveTranscript: noop,
    upsertMinutes: noop,
    postText: noop,
    synthesize: noop,
    playAudio: noop,
    scheduleInterval: () => 0,
    cancelInterval: () => {},
    logger: {},
    ownerUserId: "owner",
    tasksEnabled: true,
    getTasks: () => [
      { id: "active01", state: "running" },
      { id: "active02", state: "queued" },
    ],
    controlTask: async (control) => {
      controls.push(control);
      return { type: "cancelled" };
    },
  });
  t.after(() => session.stop());
  await session.addText("井戸Bot、タスク active01 を停止して", {
    userId: "member",
  });
  await session.addText("井戸Bot、タスク active01 を停止して", {
    userId: "owner",
    taskEligible: false,
  });
  await session.addText("井戸Bot、停止して", { userId: "owner" });
  assert.equal(controls.length, 0);
  await session.addText("井戸Bot、タスク active01 を停止して", {
    userId: "owner",
  });
  assert.equal(controls.length, 1);
  assert.equal(controls[0].taskId, "active01");
  assert.equal(session.statements.at(-1).taskEligible, false);
});

test("a saved stop rejects old observation controls after restart but allows a new explicit continuation", async (t) => {
  let runs = 0;
  const tasks = new DiscordVoiceTaskQueue({
    logger: {},
    postText: noop,
    createTaskThread: async () => ({ post: noop, update: noop }),
    runTask: async () => {
      runs++;
      return "continued";
    },
  });
  t.after(() => tasks.stop());
  await tasks.restore(
    [{ id: "stopped1", state: "cancelled", controlVersion: 1 }],
    async () => ({ post: noop, update: noop }),
  );
  assert.equal(
    (
      await tasks.handleVoiceControlDurable({
        type: "instruction",
        taskId: "stopped1",
        instruction: "old instruction",
        expectedControlVersion: 0,
      })
    ).type,
    "superseded",
  );
  assert.equal(runs, 0);
  assert.equal(tasks.snapshot()[0].controlVersion, 1);
  assert.equal(
    (
      await tasks.handleVoiceControlDurable({
        type: "instruction",
        taskId: "stopped1",
        instruction: "new instruction",
        expectedControlVersion: 1,
      })
    ).type,
    "instruction",
  );
  await eventually(() => tasks.active === 0);
  assert.equal(runs, 1);
});
