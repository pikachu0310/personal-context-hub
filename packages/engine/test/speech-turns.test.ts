import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type {
  SpeechDecision,
  SpeechReview,
} from "@ido/common/contracts/coordinator";
import {
  SpeechTurns,
  type SpeechCandidate,
} from "../src/output/audio/turns.js";
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1000 });
  let ready = true,
    valid = true,
    quietUntil = 0,
    resultsValid = true,
    stops = 0;
  const requests: Array<{
    review: SpeechReview;
    signal: AbortSignal;
    resolve(value?: SpeechDecision | null): void;
  }> = [];
  const replacements: SpeechCandidate[] = [],
    states: string[] = [];
  const turns = new SpeechTurns({
    valid: () => valid,
    ready: () => ready,
    quietUntil: () => quietUntil,
    conversation: () => [{ id: "message", authorId: "human", text: "latest" }],
    resultsValid: () => resultsValid,
    review: (review, signal) =>
      new Promise((resolve) => requests.push({ review, signal, resolve })),
    stop: async () => {
      stops++;
    },
    replace: (candidate) => replacements.push(candidate),
    state: (_id, state) => states.push(state),
  });
  t.after(() => turns.close());
  const offer = () =>
    turns.offer({
      text: "original",
      sourceIds: ["question"],
      targets: [],
      provider: "text-speech",
    });
  const decide = (
    action: SpeechDecision["action"],
    text: string | null = null,
  ) => {
    const request = requests.at(-1)!;
    request.resolve({
      candidateId: request.review.candidateId,
      revision: request.review.revision,
      action,
      text,
    });
  };
  return {
    turns,
    requests,
    replacements,
    states,
    offer,
    decide,
    stops: () => stops,
    ready: (v: boolean) => {
      ready = v;
    },
    valid: (v: boolean) => {
      valid = v;
    },
    quiet: (v: number) => {
      quietUntil = v;
    },
    results: (v: boolean) => {
      resultsValid = v;
    },
    tick: async (ms = 25) => {
      t.mock.timers.tick(ms);
      await flush();
    },
  };
}

test("a confirmed backchannel keeps current playback; a short stop cancels it", async (t) => {
  const f = fixture(t),
    candidate = f.offer();
  f.turns.playing(candidate);
  f.turns.changed(true);
  assert.equal(f.stops(), 0);
  await f.tick();
  f.decide("continue");
  await flush();
  assert.equal(f.turns.candidate, candidate);
  assert.equal(candidate.state, "playing");
  assert.equal(f.stops(), 0);
  f.turns.changed(true);
  await f.tick();
  f.decide("stop");
  await flush();
  assert.equal(f.turns.candidate, undefined);
  assert.equal(f.stops(), 1);
});
test("interruption waits for every speaker, STT and a single quiet interval, then rewrites once", async (t) => {
  const f = fixture(t),
    candidate = f.offer();
  f.turns.playing(candidate);
  f.ready(false);
  await f.turns.interrupt();
  await f.turns.interrupt();
  assert.equal(f.stops(), 1);
  await f.tick(1000);
  assert.equal(f.requests.length, 0);
  f.ready(true);
  f.quiet(Date.now() + 1000);
  await f.tick(999);
  assert.equal(f.requests.length, 0);
  await f.tick(25);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].review.state, "interrupted");
  f.decide("replace", "必要な要点だけ");
  await flush();
  assert.equal(f.replacements.length, 1);
  assert.notEqual(f.replacements[0].id, candidate.id);
  assert.equal(f.replacements[0].text, "必要な要点だけ");
  await f.tick(1000);
  assert.equal(f.requests.length, 1);
});
test("a newer utterance invalidates a pending decision and only the latest revision can speak", async (t) => {
  const f = fixture(t);
  f.offer();
  await f.turns.interrupt();
  await f.tick();
  const old = f.requests[0];
  f.ready(false);
  f.turns.changed();
  assert.equal(old.signal.aborted, true);
  old.resolve({ ...old.review, action: "replace", text: "stale" });
  await flush();
  assert.equal(f.replacements.length, 0);
  f.ready(true);
  f.turns.changed(true);
  await f.tick();
  f.decide("replace", "current");
  await flush();
  assert.equal(f.replacements[0].text, "current");
});
test("missing, mismatched and timed-out decisions never authorize replay", async (t) => {
  const f = fixture(t);
  f.offer();
  await f.turns.interrupt();
  await f.tick();
  f.requests.at(-1)!.resolve(undefined);
  await flush();
  assert.equal(f.turns.candidate, undefined);
  f.offer();
  await f.turns.interrupt();
  await f.tick();
  f.requests.at(-1)!.resolve({
    candidateId: "wrong",
    revision: f.turns.revision,
    action: "replace",
    text: "wrong",
  });
  await flush();
  assert.equal(f.turns.candidate, undefined);
  f.offer();
  await f.turns.interrupt();
  await f.tick();
  await f.tick(30_000);
  assert.equal(f.turns.candidate, undefined);
  assert.equal(f.replacements.length, 0);
});
test("expiry, revoked access, superseded results and explicit discard fence pending reviews", async (t) => {
  const f = fixture(t);
  for (const reason of ["expiry", "access", "result", "stop"]) {
    f.valid(true);
    f.results(true);
    f.offer();
    await f.turns.interrupt();
    await f.tick();
    const request = f.requests.at(-1)!;
    if (reason === "expiry") await f.tick(90_000);
    if (reason === "access") {
      f.valid(false);
      await f.tick();
    }
    if (reason === "result") {
      f.results(false);
      await f.tick();
    }
    if (reason === "stop") f.turns.discard();
    request.resolve({ ...request.review, action: "replace", text: "late" });
    await flush();
    assert.equal(f.turns.candidate, undefined);
  }
  assert.equal(f.replacements.length, 0);
});
test("queued speech is gated during review and completed speech is not offered again", async (t) => {
  const f = fixture(t),
    candidate = f.offer();
  f.turns.changed(true);
  assert.equal(f.turns.canStart(candidate), false);
  await f.tick();
  f.decide("continue");
  await flush();
  assert.equal(f.turns.canStart(candidate), true);
  f.turns.playing(candidate);
  f.turns.completed(candidate);
  f.turns.changed(true);
  await f.tick();
  assert.equal(f.requests.length, 1);
  assert.ok(f.states.includes("completed"));
});
