import assert from "node:assert/strict";
import test from "node:test";
import {
  DiscordVoiceTaskQueue,
  DiscordVoiceMeetingSession,
} from "../src/adapters/discord/sessions.mjs";
const noop = async () => undefined;
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
    runTask: async () => "result",
    ...options,
  });
}

test("durably accepted corrections steer an active worker and complete only the new specification", async (t) => {
  let finish,
    workerTask,
    runs = 0;
  const writes = [],
    steers = [];
  const tasks = queue({
    checkpoint: async (snapshot) => writes.push(structuredClone(snapshot)),
    runTask: async (task) => {
      runs++;
      workerTask = task;
      task.runRevision = 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    steerTask: async (task, text) => {
      assert.equal(writes.at(-1)[0].instructions[0].delivery, "sending");
      steers.push(text);
      return true;
    },
  });
  t.after(() => tasks.stop());
  await tasks.enqueueDurable({
    id: "steer",
    title: "button",
    request: "larger",
  });
  await eventually(() => finish);
  await tasks.handleTaskMessageDurable({
    taskId: "steer",
    userId: "owner",
    ownerUserId: "owner",
    content: "少し小さくして",
    requestKey: "correction",
  });
  await eventually(() => workerTask.steeredInstructions?.length === 1);
  finish("smaller button");
  await eventually(
    () => tasks.getTaskResult("steer")?.currentState === "completed",
  );
  assert.deepEqual(steers, ["少し小さくして"]);
  assert.equal(runs, 1);
  assert.equal(tasks.getTaskResult("steer").resultSpecRevision, 2);
  assert.equal(tasks.getTaskResult("steer").superseded, false);
});

test("an ambiguous steer acknowledgement aborts and preserves the instruction for manual recovery", async (t) => {
  let workerTask, workerSignal;
  const tasks = queue({
    runTask: async (task, { signal }) => {
      workerTask = task;
      workerSignal = signal;
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
    steerTask: async () => {
      throw new Error("transport lost after send");
    },
  });
  t.after(() => tasks.stop());
  await tasks.enqueueDurable({ id: "uncertain", title: "button" });
  await eventually(() => workerTask);
  await tasks.handleTaskMessageDurable({
    taskId: "uncertain",
    userId: "owner",
    ownerUserId: "owner",
    content: "訂正して",
    requestKey: "correction",
  });
  await eventually(() => workerTask.state === "failed");
  assert.equal(workerSignal.aborted, true);
  assert.equal(tasks.snapshot()[0].instructions[0].delivery, "uncertain");
});

test("a second correction arriving during acknowledgement is delivered in the same run", async (t) => {
  let finish, acknowledge;
  const steers = [];
  const tasks = queue({
    runTask: async (task) => {
      task.runRevision = 1;
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    steerTask: async (_task, text) => {
      steers.push(text);
      if (steers.length === 1)
        await new Promise((resolve) => {
          acknowledge = resolve;
        });
      return true;
    },
  });
  t.after(async () => {
    acknowledge?.();
    finish?.("done");
    await tasks.stop();
  });
  await tasks.enqueueDurable({ id: "rapid", title: "button" });
  await eventually(() => finish);
  const first = tasks.handleTaskMessageDurable(
    instruction("rapid", "小さくして", "first"),
  );
  await eventually(() => acknowledge);
  const second = tasks.handleTaskMessageDurable(
    instruction("rapid", "赤にして", "second"),
  );
  await eventually(() => tasks.snapshot()[0].instructions.length === 2);
  acknowledge();
  await Promise.all([first, second]);
  await eventually(() => steers.length === 2);
  finish("small red button");
  await eventually(
    () => tasks.getTaskResult("rapid")?.currentState === "completed",
  );
  assert.deepEqual(steers, ["小さくして", "赤にして"]);
  assert.equal(tasks.getTaskResult("rapid").resultSpecRevision, 3);
  assert.equal(tasks.getTaskResult("rapid").superseded, false);
});

for (const initialState of ["cancelled", "failed"]) {
  test(`a stalled ${initialState} notice does not hold a worker slot or overwrite a resumed task`, async (t) => {
    let releaseNotice,
      cancelNoticeStarted = false,
      runCount = 0;
    const notice = new Promise((resolve) => {
      releaseNotice = resolve;
    });
    const cards = [];
    const tasks = queue({
      concurrency: 1,
      createTaskThread: async (task) => ({
        threadId: task.id,
        post: async (content) => {
          if (
            content.includes(
              initialState === "cancelled"
                ? "Codexタスク中止"
                : "Codexタスク失敗",
            )
          ) {
            cancelNoticeStarted = true;
            await notice;
          }
        },
        update: async ({ state }) => cards.push(state),
      }),
      runTask: async (_task, { signal }) => {
        if (++runCount === 1) {
          if (initialState === "failed") throw new Error("synthetic failure");
          await new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          );
        }
        return "resumed result";
      },
    });
    t.after(async () => {
      releaseNotice();
      await tasks.stop();
    });
    await tasks.enqueueDurable({ title: "work" });
    await eventually(() => runCount === 1);
    const id = tasks.list()[0].id;
    if (initialState === "cancelled")
      await tasks.handleVoiceControlDurable({ type: "stop", taskId: id });
    await eventually(() => cancelNoticeStarted);
    await eventually(() => !tasks.tasks.get(id).executing);
    await tasks.handleVoiceControlDurable({
      type: "instruction",
      taskId: id,
      instruction: "continue",
    });
    await eventually(
      () => runCount === 2 && tasks.list()[0].state === "completed",
    );
    releaseNotice();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cards.at(-1), "completed");
  });
}
const instruction = (taskId, content, requestKey) => ({
  taskId,
  content,
  requestKey,
  userId: "owner",
  ownerUserId: "owner",
});

test("an additional instruction that fails to save cannot execute later", async (t) => {
  let fail = false,
    failedWrites = 0;
  const runs = [];
  const tasks = queue({
    checkpoint: async () => {
      if (fail) {
        failedWrites++;
        throw new Error("disk full");
      }
    },
    runTask: async (task) => {
      runs.push(task.additionalInstruction ?? "initial");
      return "result";
    },
  });
  t.after(() => tasks.stop());
  tasks.enqueue({ title: "work", request: "initial" });
  await eventually(() => runs.length === 1 && tasks.active === 0);
  const id = tasks.list()[0].id;
  fail = true;
  tasks.handleTaskMessage(instruction(id, "unsaved instruction", "control:1"));
  await eventually(() => failedWrites > 0 && tasks.active === 0);
  assert.deepEqual(runs, ["initial"]);
  fail = false;
  tasks.handleTaskMessage(instruction(id, "saved instruction", "control:2"));
  await eventually(() => runs.length === 2 && tasks.active === 0);
  assert.deepEqual(runs, ["initial", "saved instruction"]);
});

test("repeated control delivery cannot execute the same instruction twice", async (t) => {
  const runs = [];
  const tasks = queue({
    runTask: async (task) => {
      runs.push(task.additionalInstruction ?? "initial");
      return "result";
    },
  });
  t.after(() => tasks.stop());
  tasks.enqueue({ title: "work" });
  await eventually(() => runs.length === 1 && tasks.active === 0);
  const message = instruction(tasks.list()[0].id, "do this once", "control:1");
  tasks.handleTaskMessage(message);
  tasks.handleTaskMessage(message);
  await eventually(() => runs.length > 1 && tasks.active === 0);
  assert.deepEqual(runs, ["initial", "do this once"]);
});

test("an interrupted consumed instruction is retained when the owner resumes", async (t) => {
  const runs = [];
  const tasks = queue({
    runTask: async (task) => {
      runs.push(task.additionalInstruction);
      return "result";
    },
  });
  t.after(() => tasks.stop());
  await tasks.restore(
    [
      {
        id: "interrupted",
        state: "running",
        codexThreadId: "same-thread",
        additionalInstruction: "change the button to blue",
        instructions: [],
      },
    ],
    async () => ({ threadId: "thread", post: noop, update: noop }),
  );
  tasks.handleTaskMessage(
    instruction("interrupted", "continue", "control:resume"),
  );
  await eventually(() => runs.length && tasks.active === 0);
  assert.match(runs[0], /change the button to blue/);
  assert.match(runs[0], /完了未確認/);
});

test("concurrent instructions are saved separately and a rejected one never enters a later receipt", async (t) => {
  let rejectWrite,
    block = false;
  const saved = [],
    runs = [];
  const tasks = queue({
    checkpoint: async (records) => {
      if (block) {
        block = false;
        await new Promise((_, reject) => {
          rejectWrite = reject;
        });
      }
      saved.push(structuredClone(records));
    },
    runTask: async (task) => {
      runs.push(task.additionalInstruction ?? "initial");
      return "result";
    },
  });
  t.after(() => tasks.stop());
  await tasks.enqueueDurable({ title: "work" });
  await eventually(() => tasks.active === 0);
  const id = tasks.list()[0].id;
  block = true;
  const failed = assert.rejects(
    tasks.handleTaskMessageDurable(instruction(id, "must not run", "failed")),
    { code: "TASK_STATE_SAVE_FAILED" },
  );
  await eventually(() => rejectWrite);
  let acknowledged = false;
  const accepted = tasks
    .handleTaskMessageDurable(instruction(id, "must run", "accepted"))
    .then(() => {
      acknowledged = true;
    });
  assert.equal(acknowledged, false);
  assert.deepEqual(tasks.snapshot()[0].instructions, []);
  rejectWrite(new Error("disk full"));
  await failed;
  await accepted;
  await eventually(() => tasks.active === 0 && runs.length === 2);
  assert.deepEqual(runs, ["initial", "must run"]);
  for (const records of saved) {
    assert.equal(JSON.stringify(records).includes("must not run"), false);
    assert.equal(Object.hasOwn(records[0].controlReceipts, "failed"), false);
  }
});

test("stopping aborts immediately even if saving the stop fails and its receipt can be retried", async (t) => {
  let workerSignal,
    fail = false;
  const tasks = queue({
    checkpoint: async () => {
      if (fail) throw new Error("disk full");
    },
    runTask: async (_task, { signal }) => {
      workerSignal = signal;
      await new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  t.after(() => tasks.stop());
  await tasks.enqueueDurable({ title: "long work" });
  await eventually(() => workerSignal);
  fail = true;
  const stop = instruction(tasks.list()[0].id, "停止", "stop:1");
  const pending = tasks.handleTaskMessageDurable(stop);
  assert.equal(workerSignal.aborted, true);
  assert.equal((await pending).persisted, false);
  fail = false;
  assert.notEqual(
    (await tasks.handleTaskMessageDurable(stop)).persisted,
    false,
  );
  await eventually(() => tasks.active === 0);
  assert.equal(tasks.snapshot()[0].state, "cancelled");
});

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
        minutes: "会議",
        shouldReply: true,
        reply: "停止しました",
        taskControls: [
          { type: "stop", sourceSequences: [statements[0].sequence] },
        ],
      }),
    ...options,
  });
}

test("a correction reaches the active task while meeting observation is still running", async (t) => {
  let finishObservation,
    observing = false;
  const controls = [];
  const session = meeting({
    getTasks: () => [{ id: "task", state: "running" }],
    controlTask: async (control) => {
      controls.push(control);
      return { persisted: true };
    },
    observe: async () => {
      observing = true;
      return new Promise((resolve) => {
        finishObservation = resolve;
      });
    },
  });
  t.after(async () => {
    finishObservation?.(
      JSON.stringify({ minutes: "会議", shouldReply: false }),
    );
    await session.stop();
  });
  await session.addText("ボタンの大きさを検討します", { userId: "owner" });
  const observation = session.observeNow();
  await eventually(() => observing);
  await session.addText("やっぱりボタンを小さくして", { userId: "owner" });
  assert.equal(controls.length, 1);
  assert.equal(controls[0].taskId, "task");
  assert.equal(controls[0].type, "instruction");
  finishObservation(JSON.stringify({ minutes: "会議", shouldReply: false }));
  await observation;
  assert.equal(controls.length, 1);
});

test("voice control retains its concrete target across a save failure and restart", async (t) => {
  let state,
    controls = [],
    posts = [];
  const session = meeting({
    getTasks: () => [{ id: "original", state: "running" }],
    checkpoint: async (value) => {
      state = structuredClone(value);
    },
    controlTask: async () => {
      throw new Error("disk full");
    },
    postText: async (text) => posts.push(text),
  });
  t.after(() => session.stop());
  await session.addText("井戸Bot、そのタスクを停止して", { userId: "owner" });
  assert.equal(await session.observeNow(), true);
  assert.equal(state.pendingControls[0].taskId, "original");
  assert.equal(
    posts.some((text) => text.includes("停止しました")),
    false,
  );
  const restored = meeting({
    initialState: state,
    getTasks: () => [{ id: "different", state: "running" }],
    controlTask: async (control) => {
      controls.push(control);
      return { type: "cancelled" };
    },
    postText: async (text) => posts.push(text),
  });
  t.after(() => restored.stop());
  await restored.observeNow();
  await restored.observeNow();
  assert.equal(controls.length, 1);
  assert.equal(controls[0].taskId, "original");
  assert.equal(restored.pendingControls.length, 0);
  assert.equal(posts.filter((text) => text.includes("停止しました")).length, 1);
});

test("a restored voice receipt confirms its outcome without reapplying the instruction", async (t) => {
  const tasks = queue();
  t.after(() => tasks.stop());
  await tasks.enqueueDurable({ title: "work" });
  await eventually(() => tasks.active === 0);
  const id = tasks.list()[0].id;
  await tasks.handleVoiceControlDurable({
    taskId: id,
    type: "instruction",
    instruction: "continue once",
    requestKey: "voice:1",
  });
  await eventually(() => tasks.active === 0);
  const restoredTasks = queue({
    runTask: async () =>
      assert.fail("must not execute the saved control twice"),
  });
  t.after(() => restoredTasks.stop());
  await restoredTasks.restore(tasks.snapshot(), async (task) => ({
    threadId: task.id,
    post: noop,
    update: noop,
  }));
  const session = meeting({
    initialState: {
      pendingControls: [
        {
          taskId: id,
          type: "instruction",
          instruction: "continue once",
          requestKey: "voice:1",
        },
      ],
    },
    controlTask: (control) => restoredTasks.handleVoiceControlDurable(control),
  });
  t.after(() => session.stop());
  await session.observeNow();
  assert.equal(session.pendingControls.length, 0);
  assert.equal(restoredTasks.active, 0);
});

test("a full instruction queue stays rejected when the notification is retried", async (t) => {
  let calls = 0,
    failPost = true;
  const session = meeting({
    initialState: {
      pendingControls: [
        {
          taskId: "work",
          type: "instruction",
          instruction: "later",
          requestKey: "full:1",
        },
      ],
    },
    controlTask: () => {
      calls++;
      return { type: "full" };
    },
    postText: async () => {
      if (failPost) throw new Error("Discord unavailable");
    },
  });
  t.after(() => session.stop());
  await session.observeNow();
  failPost = false;
  await session.observeNow();
  assert.equal(calls, 1);
  assert.equal(session.pendingControls.length, 0);
});
