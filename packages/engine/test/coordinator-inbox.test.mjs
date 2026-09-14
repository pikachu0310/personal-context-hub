import assert from "node:assert/strict";
import test from "node:test";
import { CoordinatorInbox } from "../src/processing/coordinator/inbox.mjs";

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail("expected asynchronous state was not reached");
}
const event = (id, text = id) => ({ id, text });
function fixture(options = {}) {
  const calls = [],
    steers = [],
    applied = [],
    saved = [],
    errors = [];
  const runtime = {
    run: async (input, executionOptions) => {
      calls.push(input.map((item) => item.id));
      return options.run
        ? options.run(input, executionOptions)
        : `response-${calls.length}`;
    },
    steer: async (input) => {
      steers.push(input.map((item) => item.id));
      return options.steer ? options.steer(input) : true;
    },
    interrupt: options.interrupt ?? (async () => {}),
    close: options.close ?? (async () => {}),
  };
  const inbox = new CoordinatorInbox({
    createRuntime: options.createRuntime ?? (async () => runtime),
    buildObservation: (events) => structuredClone(events),
    onResponse: async (response, batch) => {
      applied.push({ response, batch });
      await options.onResponse?.(response, batch);
    },
    checkpoint: async (state) => {
      await options.checkpoint?.(state);
      saved.push(structuredClone(state));
    },
    onError: (error) => {
      errors.push(error);
      options.onError?.(error);
    },
    initialState: options.initialState,
    maximumBatchEvents: options.maximumBatchEvents,
    maximumBatchCharacters: options.maximumBatchCharacters,
  });
  return { inbox, runtime, calls, steers, applied, saved, errors };
}

test("definitely rejected provider input stays prepared until a later explicit flush", async () => {
  let available = false;
  const data = fixture({
    run: async () => {
      if (!available)
        throw Object.assign(new Error("COORDINATOR_NOT_STARTED"), {
          delivery: "rejected",
        });
      return "response";
    },
  });
  await data.inbox.submit([event("needs-login")]);
  await data.inbox.flush();
  await new Promise(setImmediate);
  assert.equal(data.inbox.uncertain, false);
  assert.equal(data.inbox.snapshot().active.status, "prepared");
  assert.equal(data.calls.length, 1);
  available = true;
  await data.inbox.flush();
  assert.equal(data.calls.length, 2);
  assert.equal(data.applied.length, 1);
  assert.deepEqual(data.inbox.snapshot().receipts, ["needs-login"]);
  await data.inbox.close();
});

test("normal input waits for the active coordinator turn and drains afterward", async () => {
  const first = deferred();
  const { inbox, calls, steers, applied } = fixture({
    run: (input) => (input[0].id === "a" ? first.promise : "next"),
  });
  await inbox.submit([event("a")]);
  assert.equal(calls.length, 0);
  const draining = inbox.flush();
  await until(() => calls.length === 1);
  await inbox.submit([event("b"), event("c")]);
  assert.deepEqual(calls, [["a"]]);
  assert.equal(steers.length, 0);
  first.resolve("first");
  await draining;
  assert.deepEqual(calls, [["a"], ["b", "c"]]);
  assert.deepEqual(
    applied.map(({ response }) => response),
    ["first", "next"],
  );
  assert.equal(inbox.busy, false);
  assert.deepEqual(inbox.snapshot().receipts, ["a", "b", "c"]);
});

test("urgent steering includes earlier context in bounded batches and catches another urgent arrival", async () => {
  const run = deferred(),
    firstSteer = deferred();
  let steeringCalls = 0;
  const { inbox, calls, steers, applied } = fixture({
    maximumBatchEvents: 2,
    run: () => run.promise,
    steer: () => (++steeringCalls === 1 ? firstSteer.promise : true),
  });
  await inbox.submit([event("a")], { start: true });
  await until(() => calls.length === 1);
  await inbox.submit([event("b"), event("c")]);
  await inbox.submit([event("d")], { urgent: true });
  await until(() => steers.length === 1);
  await inbox.submit([event("e")], { urgent: true });
  firstSteer.resolve(true);
  await until(() => steers.length === 2);
  await inbox.steering;
  assert.deepEqual(steers, [
    ["b", "c"],
    ["d", "e"],
  ]);
  run.resolve("combined");
  await inbox.flush();
  assert.deepEqual(calls, [["a"]]);
  assert.deepEqual(
    applied[0].batch.events.map((item) => item.id),
    ["a", "b", "c", "d", "e"],
  );
  assert.deepEqual(inbox.snapshot().urgentIds, []);
});

test("urgent input submitted while the runtime is preparing steers once the turn starts", async () => {
  const preparing = deferred(),
    running = deferred();
  const data = fixture({
    createRuntime: () => preparing.promise,
    run: () => running.promise,
  });
  await data.inbox.submit([event("a")], { start: true });
  await until(() => data.inbox.preparing);
  await data.inbox.submit([event("b")], { urgent: true });
  preparing.resolve(data.runtime);
  await until(() => data.steers.length === 1);
  running.resolve("answer");
  await data.inbox.flush();
  assert.deepEqual(data.calls, [["a"]]);
  assert.deepEqual(data.steers, [["b"]]);
});

test("a rejected steer moves its inputs to the next turn without repeated steering", async () => {
  const first = deferred();
  const { inbox, calls, steers } = fixture({
    run: (input) => (input[0].id === "a" ? first.promise : "next"),
    steer: () => false,
  });
  await inbox.submit([event("a")], { start: true });
  await until(() => calls.length === 1);
  await inbox.submit([event("b")], { urgent: true });
  await until(() => steers.length === 1 && !inbox.steering);
  assert.deepEqual(calls, [["a"]]);
  first.resolve("first");
  await inbox.flush();
  assert.deepEqual(calls, [["a"], ["b"]]);
  assert.equal(steers.length, 1);
});

test("ambiguous steering freezes all output and retains sources without blind replay", async () => {
  const run = deferred();
  const data = fixture({
    run: () => run.promise,
    steer: () => {
      throw new Error("lost steer acknowledgement");
    },
  });
  await data.inbox.submit([event("a")], { start: true });
  await until(() => data.calls.length === 1);
  await data.inbox.submit([event("b")], { urgent: true });
  await until(() => data.inbox.uncertain);
  run.resolve("possibly outdated");
  await until(() => !data.inbox.busy);
  assert.equal(await data.inbox.flush(), false);
  assert.equal(data.applied.length, 0);
  const snapshot = data.inbox.snapshot();
  assert.deepEqual(
    snapshot.active.steering.map((item) => item.id),
    ["b"],
  );
  const restored = fixture({ initialState: snapshot });
  assert.equal(await restored.inbox.flush(), false);
  assert.equal(restored.calls.length, 0);
  assert.equal(await restored.inbox.resolveUncertain({ retry: false }), true);
  await restored.inbox.submit([event("a"), event("b")], { start: true });
  await restored.inbox.flush();
  assert.equal(restored.calls.length, 0);
});

test("ambiguous run can retry only after a deliberate resolution", async () => {
  let fail = true;
  const data = fixture({
    run: () => {
      if (fail) throw new Error("disconnected after send");
      return "reconciled";
    },
  });
  await data.inbox.submit([event("a")]);
  await data.inbox.flush();
  assert.equal(data.inbox.uncertain, true);
  await data.inbox.flush();
  assert.equal(data.calls.length, 1);
  await assert.rejects(data.inbox.resolveUncertain({}), /retry decision/);
  fail = false;
  await data.inbox.resolveUncertain({ retry: true });
  await data.inbox.flush();
  assert.deepEqual(data.calls, [["a"], ["a"]]);
  assert.equal(data.applied.length, 1);
});

test("restored saved responses reapply through output without creating or rerunning a model", async () => {
  const data = fixture({
    initialState: {
      active: {
        id: "batch-1",
        events: [event("a")],
        status: "response",
        response: "saved answer",
      },
      handle: { threadId: "persistent-thread" },
    },
    createRuntime: () =>
      assert.fail("saved response must not create a provider runtime"),
  });
  await data.inbox.flush();
  assert.equal(data.applied.length, 1);
  assert.equal(data.applied[0].batch.id, "batch-1");
  assert.equal(data.applied[0].response, "saved answer");
  assert.equal(data.inbox.snapshot().active, undefined);
  assert.deepEqual(data.inbox.snapshot().receipts, ["a"]);
});

test("restored unsent prepared batches resume the same thread and sending batches remain uncertain", async () => {
  let receivedThread;
  const data = fixture({
    initialState: {
      active: { id: "batch-1", events: [event("a")], status: "prepared" },
      handle: { threadId: "persistent-thread" },
    },
    createRuntime: ({ threadId }) => {
      receivedThread = threadId;
      return data.runtime;
    },
  });
  await data.inbox.flush();
  assert.equal(receivedThread, "persistent-thread");
  assert.deepEqual(data.calls, [["a"]]);
  const restored = fixture({
    initialState: {
      active: { id: "batch-2", events: [event("b")], status: "sending" },
    },
  });
  await restored.inbox.flush();
  assert.equal(restored.inbox.uncertain, true);
  assert.equal(restored.calls.length, 0);
});

test("event identity deduplicates pending, active, steered, and receipted submissions", async () => {
  const run = deferred(),
    steering = deferred();
  const data = fixture({
    run: () => run.promise,
    steer: () => steering.promise,
  });
  const input = event("a");
  await data.inbox.submit([input, input]);
  input.text = "mutated by caller";
  assert.equal(data.inbox.snapshot().pending[0].text, "a");
  const draining = data.inbox.flush();
  await until(() => data.calls.length === 1);
  await data.inbox.submit([event("a"), event("b")], { urgent: true });
  await until(() => data.steers.length === 1);
  await data.inbox.submit([event("a"), event("b")]);
  steering.resolve(true);
  await data.inbox.steering;
  run.resolve("answer");
  await draining;
  await data.inbox.submit([event("a"), event("b")], { start: true });
  await data.inbox.flush();
  assert.deepEqual(data.calls, [["a"]]);
  assert.deepEqual(data.steers, [["b"]]);
});

test("an urgent duplicate upgrades the existing queued input rather than creating another event", async () => {
  const run = deferred();
  const data = fixture({ run: () => run.promise });
  await data.inbox.submit([event("a")], { start: true });
  await until(() => data.calls.length === 1);
  await data.inbox.submit([event("b")]);
  await data.inbox.submit([event("b", "ignored replacement")], {
    urgent: true,
  });
  await until(() => data.steers.length === 1);
  await data.inbox.steering;
  run.resolve("answer");
  await data.inbox.flush();
  assert.equal(data.applied[0].batch.events[1].text, "b");
  assert.deepEqual(data.steers, [["b"]]);
});

test("batch count and character limits hold and invalid submissions are atomic", async () => {
  const data = fixture({ maximumBatchEvents: 2, maximumBatchCharacters: 45 });
  await assert.rejects(
    data.inbox.submit([event("a"), { text: "missing id" }]),
    /event id/,
  );
  await assert.rejects(
    data.inbox.submit([event("a"), event("too-large", "x".repeat(50))]),
    /maximum batch characters/,
  );
  assert.equal(data.inbox.snapshot().pending.length, 0);
  await data.inbox.submit([event("a"), event("b"), event("c")]);
  await data.inbox.flush();
  assert.deepEqual(data.calls, [["a", "b"], ["c"]]);
});

test("close during runtime preparation interrupts and closes the late runtime without starting a turn", async () => {
  const preparing = deferred();
  let interrupted = 0,
    closed = 0;
  const data = fixture({
    createRuntime: () => preparing.promise,
    interrupt: () => interrupted++,
    close: () => closed++,
  });
  await data.inbox.submit([event("a")], { start: true });
  await until(() => data.inbox.preparing);
  const closing = data.inbox.close();
  preparing.resolve(data.runtime);
  await closing;
  assert.equal(interrupted, 1);
  assert.equal(closed, 1);
  assert.equal(data.calls.length, 0);
  assert.equal(data.inbox.snapshot().active.status, "prepared");
  assert.equal(await data.inbox.submit([event("b")]), false);
});

test("close interrupts a provider run and a returned response can resume without another model call", async () => {
  const running = deferred();
  let closed = 0;
  const data = fixture({
    run: () => running.promise,
    interrupt: () => running.resolve("finished while closing"),
    close: () => closed++,
  });
  await data.inbox.submit([event("a")], { start: true });
  await until(() => data.calls.length === 1);
  await data.inbox.close();
  assert.equal(data.applied.length, 0);
  assert.equal(closed, 1);
  const restored = fixture({ initialState: data.inbox.snapshot() });
  await restored.inbox.flush();
  assert.equal(restored.calls.length, 0);
  assert.equal(restored.applied[0].response, "finished while closing");
});

test("a failed pre-send checkpoint never invokes the provider until a successful retry", async () => {
  let fail = true;
  const data = fixture({
    checkpoint: (state) => {
      if (state.active?.status === "sending" && fail) {
        fail = false;
        throw new Error("disk full");
      }
    },
  });
  await data.inbox.submit([event("a")]);
  await data.inbox.flush();
  assert.equal(data.calls.length, 0);
  assert.equal(data.inbox.snapshot().active.status, "prepared");
  await data.inbox.flush();
  assert.deepEqual(data.calls, [["a"]]);
});

test("a failed submission checkpoint is retried before any model input is sent", async () => {
  let fail = true;
  const data = fixture({
    checkpoint: () => {
      if (fail) {
        fail = false;
        throw new Error("disk full");
      }
    },
  });
  await assert.rejects(
    data.inbox.submit([event("a")], { start: true }),
    /disk full/,
  );
  assert.equal(data.calls.length, 0);
  await data.inbox.flush();
  assert.deepEqual(data.calls, [["a"]]);
  assert.ok(data.saved.some((state) => state.active?.status === "sending"));
});

test("provider preparation failure can retry because no model turn was submitted", async () => {
  let attempts = 0;
  const data = fixture({
    createRuntime: () => {
      if (++attempts === 1) throw new Error("not connected");
      return data.runtime;
    },
  });
  await data.inbox.submit([event("a")]);
  await data.inbox.flush();
  assert.equal(data.inbox.uncertain, false);
  await data.inbox.flush();
  assert.equal(attempts, 2);
  assert.deepEqual(data.calls, [["a"]]);
});

test("failed response application and response checkpoint retry without rerunning the model", async () => {
  let checkpointFailure = true,
    outputFailure = true;
  const data = fixture({
    checkpoint: (state) => {
      if (state.active?.status === "response" && checkpointFailure) {
        checkpointFailure = false;
        throw new Error("response checkpoint failed");
      }
    },
    onResponse: () => {
      if (outputFailure) {
        outputFailure = false;
        throw new Error("output temporarily unavailable");
      }
    },
  });
  await data.inbox.submit([event("a")]);
  await data.inbox.flush();
  assert.equal(data.applied.length, 0);
  await data.inbox.flush();
  assert.equal(data.applied.length, 1);
  await data.inbox.flush();
  assert.deepEqual(data.calls, [["a"]]);
  assert.equal(data.applied.length, 2);
  assert.equal(data.inbox.snapshot().active, undefined);
});

test("concurrent submit cannot persist an already completed batch back into active state", async () => {
  const savingReceipt = deferred();
  let reachedReceipt = false;
  const data = fixture({
    checkpoint: async (state) => {
      if (!state.active && state.receipts.includes("a") && !reachedReceipt) {
        reachedReceipt = true;
        await savingReceipt.promise;
      }
    },
  });
  await data.inbox.submit([event("a")], { start: true });
  await until(() => reachedReceipt);
  const submission = data.inbox.submit([event("b")], { start: true });
  savingReceipt.resolve();
  await submission;
  await data.inbox.flush();
  assert.deepEqual(data.calls, [["a"], ["b"]]);
  assert.equal(data.saved.at(-1).active, undefined);
  assert.deepEqual(data.saved.at(-1).receipts, ["a", "b"]);
});

test("flush wake arriving after an empty drain is not lost behind the running flag", async () => {
  const data = fixture();
  const originalDrain = data.inbox.drain.bind(data.inbox);
  let injected = false;
  data.inbox.drain = async () => {
    const result = await originalDrain();
    if (!injected) {
      injected = true;
      await data.inbox.submit([event("late")], { start: true });
    }
    return result;
  };
  await data.inbox.flush();
  assert.deepEqual(data.calls, [["late"]]);
  assert.equal(data.inbox.busy, false);
});

test("accepted steering with failed receipt persistence freezes instead of replaying", async () => {
  const running = deferred();
  let fail = true;
  const data = fixture({
    run: () => running.promise,
    checkpoint: (state) => {
      if (state.active?.events.length === 2 && fail) {
        fail = false;
        throw new Error("steer receipt disk failure");
      }
    },
    onError: () => {
      throw new Error("observer failure is isolated");
    },
  });
  await data.inbox.submit([event("a")], { start: true });
  await until(() => data.calls.length === 1);
  await data.inbox.submit([event("b")], { urgent: true });
  await until(() => data.inbox.uncertain);
  running.resolve("answer");
  await until(() => !data.inbox.busy);
  await data.inbox.flush();
  assert.deepEqual(data.calls, [["a"]]);
  assert.deepEqual(data.steers, [["b"]]);
  assert.equal(data.applied.length, 0);
});

test("repeated response checkpoint failure cannot apply an undurable response", async () => {
  let diskUnavailable = true;
  const data = fixture({
    checkpoint: (state) => {
      if (diskUnavailable && state.active?.status === "response")
        throw new Error("disk unavailable");
    },
  });
  await data.inbox.submit([event("a")]);
  await data.inbox.flush();
  await data.inbox.flush();
  assert.deepEqual(data.calls, [["a"]]);
  assert.equal(data.applied.length, 0);
  diskUnavailable = false;
  await data.inbox.flush();
  assert.equal(data.applied.length, 1);
});

test("a failed pre-steer checkpoint returns known-unsent inputs to the next turn", async () => {
  const running = deferred();
  let fail = true;
  const data = fixture({
    run: (input) => (input[0].id === "a" ? running.promise : "next"),
    checkpoint: (state) => {
      if (state.active?.steering && fail) {
        fail = false;
        throw new Error("disk unavailable");
      }
    },
  });
  await data.inbox.submit([event("a")], { start: true });
  await until(() => data.calls.length === 1);
  await data.inbox.submit([event("b")], { urgent: true });
  await until(() => data.errors.length === 1);
  running.resolve("first");
  await data.inbox.flush();
  assert.deepEqual(data.steers, []);
  assert.deepEqual(data.calls, [["a"], ["b"]]);
  assert.equal(data.inbox.uncertain, false);
});

test("concurrent uncertain resolutions cannot duplicate retried input", async () => {
  const data = fixture({
    initialState: {
      active: { id: "batch", status: "uncertain", events: [event("a")] },
    },
  });
  const resolutions = await Promise.all([
    data.inbox.resolveUncertain({ retry: true }),
    data.inbox.resolveUncertain({ retry: true }),
  ]);
  assert.deepEqual(resolutions, [true, false]);
  await data.inbox.flush();
  assert.deepEqual(data.calls, [["a"]]);
});
