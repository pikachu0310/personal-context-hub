import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { SpeechStartGate } from "../src/adapters/discord/speech-start.mjs";

function fixture(t, { users = [], silenceMs } = {}) {
  let time = 0;
  let nextTimer = 0;
  const timers = new Map();
  const speaking = new EventEmitter();
  speaking.users = new Map(users.map((user) => [user, 0]));
  const clock = {
    now: () => time,
    schedule: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, { callback, at: time + delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
    advance: (duration) => {
      const target = time + duration;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        time = timer.at;
        timer.callback();
      }
      time = target;
    },
  };
  const gate = new SpeechStartGate(speaking, {
    ...clock,
    ...(silenceMs === undefined ? {} : { silenceMs }),
  });
  t.after(() => gate.dispose());
  return { gate, speaking, clock, timers };
}

test("playback starts synchronously at the default one-second quiet boundary", async (t) => {
  const { gate, clock, timers } = fixture(t);
  let startedAt;
  const ready = gate.runWhenQuiet(() => {
    startedAt = clock.now();
    return "playing";
  });
  clock.advance(999);
  assert.equal(startedAt, undefined);
  clock.advance(1);
  assert.equal(startedAt, 1_000);
  assert.equal(await ready, "playing");
  assert.equal(timers.size, 0);
});

test("every participant, including users already speaking when attached, must finish", async (t) => {
  const { gate, speaking, clock, timers } = fixture(t, { users: ["alice"] });
  let starts = 0;
  const ready = gate.runWhenQuiet(() => starts++);
  speaking.emit("start", "bob");
  clock.advance(2_000);
  speaking.emit("end", "alice");
  clock.advance(2_000);
  assert.equal(starts, 0);
  assert.equal(timers.size, 0);
  speaking.emit("end", "bob");
  clock.advance(999);
  assert.equal(starts, 0);
  clock.advance(1);
  assert.equal(starts, 1);
  await ready;
});

test("renewed speech cancels the pending start and restarts the full quiet period", async (t) => {
  const { gate, speaking, clock, timers } = fixture(t);
  let startedAt;
  const ready = gate.runWhenQuiet(() => {
    startedAt = clock.now();
  });
  clock.advance(999);
  speaking.emit("start", "alice");
  assert.equal(timers.size, 0);
  clock.advance(2_000);
  assert.equal(startedAt, undefined);
  speaking.emit("end", "alice");
  clock.advance(999);
  assert.equal(startedAt, undefined);
  clock.advance(1);
  assert.equal(startedAt, 3_999);
  await ready;
});

test("ready audio uses elapsed quiet time instead of waiting again on each enqueue", async (t) => {
  const { gate, clock, timers } = fixture(t);
  clock.advance(5_000);
  const starts = [];
  const first = gate.runWhenQuiet(() => starts.push(clock.now()));
  assert.deepEqual(starts, [5_000]);
  clock.advance(100);
  const second = gate.runWhenQuiet(() => starts.push(clock.now()));
  assert.deepEqual(starts, [5_000, 5_100]);
  assert.equal(timers.size, 0);
  await Promise.all([first, second]);
});

test("quiet audio admission still checks speech that began while audio was being prepared", async (t) => {
  const { gate, speaking, clock } = fixture(t);
  clock.advance(5_000);
  speaking.emit("start", "alice");
  let starts = 0;
  const ready = gate.runWhenQuiet(() => starts++);
  clock.advance(5_000);
  assert.equal(starts, 0);
  speaking.emit("end", "alice");
  clock.advance(1_000);
  assert.equal(starts, 1);
  await ready;
});

for (const initiallySpeaking of [false, true]) {
  test(`aborting while ${initiallySpeaking ? "a participant speaks" : "the quiet timer runs"} prevents playback`, async (t) => {
    const { gate, speaking, clock, timers } = fixture(t, {
      users: initiallySpeaking ? ["alice"] : [],
    });
    const controller = new AbortController();
    const reason = new Error("request canceled");
    let starts = 0;
    const ready = gate.runWhenQuiet(() => starts++, {
      signal: controller.signal,
    });
    const rejected = assert.rejects(ready, (error) => error === reason);
    controller.abort(reason);
    await rejected;
    assert.equal(timers.size, 0);
    speaking.emit("end", "alice");
    clock.advance(2_000);
    assert.equal(starts, 0);
    assert.equal(timers.size, 0);
  });
}

test("an already aborted request cannot start even after a long quiet period", async (t) => {
  const { gate, clock } = fixture(t);
  clock.advance(5_000);
  const controller = new AbortController();
  controller.abort(new Error("already canceled"));
  await assert.rejects(
    gate.runWhenQuiet(() => assert.fail("must not start"), {
      signal: controller.signal,
    }),
    /already canceled/,
  );
});

for (const initiallySpeaking of [false, true]) {
  test(`dispose rejects pending admission and removes listeners ${initiallySpeaking ? "during speech" : "during quiet"}`, async (t) => {
    const { gate, speaking, clock, timers } = fixture(t, {
      users: initiallySpeaking ? ["alice"] : [],
    });
    let starts = 0;
    const ready = gate.runWhenQuiet(() => starts++);
    const rejected = assert.rejects(ready, /Speech start gate closed/);
    gate.dispose();
    await rejected;
    assert.equal(speaking.listenerCount("start"), 0);
    assert.equal(speaking.listenerCount("end"), 0);
    assert.equal(timers.size, 0);
    gate.dispose();
    speaking.emit("end", "alice");
    clock.advance(2_000);
    assert.equal(starts, 0);
    await assert.rejects(
      gate.runWhenQuiet(() => starts++),
      /Speech start gate closed/,
    );
    assert.equal(starts, 0);
  });
}

test("human speech after playback starts does not interrupt or repeat that playback", async (t) => {
  const { gate, speaking, clock, timers } = fixture(t);
  clock.advance(1_000);
  let finishPlayback;
  let starts = 0;
  let settled = false;
  const ready = gate
    .runWhenQuiet(() => {
      starts++;
      return new Promise((resolve) => {
        finishPlayback = resolve;
      });
    })
    .finally(() => {
      settled = true;
    });
  speaking.emit("start", "alice");
  clock.advance(2_000);
  speaking.emit("end", "alice");
  clock.advance(2_000);
  await Promise.resolve();
  assert.equal(starts, 1);
  assert.equal(settled, false);
  assert.equal(timers.size, 0);
  finishPlayback("finished normally");
  assert.equal(await ready, "finished normally");
});

test("a configured quiet duration is used independently of the default", async (t) => {
  const { gate, clock } = fixture(t, { silenceMs: 250 });
  let starts = 0;
  const ready = gate.runWhenQuiet(() => starts++);
  clock.advance(249);
  assert.equal(starts, 0);
  clock.advance(1);
  assert.equal(starts, 1);
  await ready;
});
