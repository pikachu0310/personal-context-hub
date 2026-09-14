import assert from "node:assert/strict";
import test from "node:test";
import { createSpeechController } from "../src/engine/output/speech-controller.mjs";

const nextTick = () => new Promise(setImmediate);

function setup(overrides = {}) {
  const state = {
    meetingId: "meeting",
    modeRevision: 0,
    revision: 0,
    pendingTranscripts: 0,
    conversation: [],
    results: [],
  };
  const synthesized = [],
    played = [],
    errors = [];
  const controller = createSpeechController({
    getState: () => state,
    synthesize: async (text) => {
      synthesized.push(text);
      return text;
    },
    playAudio: async (audio, options) => {
      assert.equal(options.canStart(), true);
      played.push(audio);
    },
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return { controller, state, synthesized, played, errors };
}

test("speech controller replaces queued duplicates and rejects an older source order", async () => {
  const { controller, synthesized, played } = setup();
  const first = controller.enqueue({
    text: "old",
    targets: [{ text: "状態は？", sequence: 1 }],
  });
  const second = controller.enqueue({
    text: "new",
    targets: [{ text: "状態は？", sequence: 2 }],
  });
  await Promise.all([first, second]);
  await controller.enqueue({
    text: "late old",
    targets: [{ text: "状態は？", sequence: 1 }],
  });
  assert.deepEqual(synthesized, ["new"]);
  assert.deepEqual(played, ["new"]);
  assert.equal(controller.pending, 0);
});

test("speech controller revalidates against current context and exposes synchronous start protection", async () => {
  const validations = [];
  let release, entered;
  const enteredPlayer = new Promise((resolve) => (entered = resolve));
  const { controller, state, played } = setup({
    validate: async (input) => {
      validations.push(input);
      return { decision: "keep" };
    },
    playAudio: async (audio, options) => {
      entered();
      await new Promise((resolve) => (release = resolve));
      assert.equal(
        options.canStart(),
        false,
        "new context revokes prior lease",
      );
      assert.equal(await options.beforeStart(), true);
      assert.equal(options.canStart(), true);
      played.push(audio);
    },
  });
  state.conversation = [
    { role: "user", sequence: 1, text: "依頼" },
    { role: "user", sequence: 2, text: "補足" },
  ];
  const delivery = controller.enqueue({
    text: "answer",
    targets: [{ sequence: 1, text: "依頼" }],
  });
  await enteredPlayer;
  state.revision++;
  state.conversation.push({ sequence: 3, role: "user", text: "訂正" });
  release();
  await delivery;
  assert.equal(validations.length, 2);
  assert.deepEqual(
    validations[0].conversation.map((item) => item.sequence),
    [2],
  );
  assert.deepEqual(
    validations[1].conversation.map((item) => item.sequence),
    [2, 3],
  );
  assert.deepEqual(played, ["answer"]);
});

test("speech controller cancellation aborts current synthesis and all queued work, then accepts fresh replies", async () => {
  let synthesizeSignal;
  const { controller, played, errors } = setup({
    synthesize: (text, { signal }) => {
      if (text !== "old") return Promise.resolve(text);
      synthesizeSignal = signal;
      return new Promise((resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  void controller.enqueue({ text: "old" });
  void controller.enqueue({ text: "queued" });
  await nextTick();
  assert.equal(controller.cancel(), 2);
  assert.equal(synthesizeSignal.aborted, true);
  await controller.idle();
  assert.deepEqual(played, []);
  assert.deepEqual(errors, []);
  await controller.enqueue({ text: "fresh" });
  assert.deepEqual(played, ["fresh"]);
});

test("speech controller drops stale task results and candidates from a prior meeting or mode", async () => {
  let finishSynthesis;
  const { controller, state, played } = setup({
    synthesize: () => new Promise((resolve) => (finishSynthesis = resolve)),
  });
  state.results = [{ id: "task-1", runRevision: 1 }];
  const delivery = controller.enqueue({
    text: "result",
    targets: [{ text: "task result", resultId: "task-1", runRevision: 1 }],
  });
  await nextTick();
  state.results[0].superseded = true;
  finishSynthesis("result");
  await delivery;
  await controller.enqueue({ text: "wrong meeting", meetingId: "old-meeting" });
  await controller.enqueue({ text: "wrong mode", modeRevision: -1 });
  assert.deepEqual(played, []);
});

test("speech controller waits for pending transcripts and honors a cancelled validation", async () => {
  const { controller, state, played } = setup({
    validate: async () => ({ decision: "cancel" }),
  });
  state.pendingTranscripts = 1;
  const delivery = controller.enqueue({ text: "answer" });
  await nextTick();
  assert.equal(controller.pending, 1);
  state.pendingTranscripts = 0;
  await delivery;
  assert.deepEqual(played, []);
  await controller.close();
  await controller.enqueue({ text: "after close" });
  assert.equal(controller.pending, 0);
});

test("a speech provider failure does not poison later replies or bypass shutdown", async () => {
  const shutdown = new AbortController();
  const { controller, played, errors } = setup({
    signal: shutdown.signal,
    synthesize: async (text) => {
      if (text === "bad") throw new Error("TTS unavailable");
      return text;
    },
  });
  await controller.enqueue({ text: "bad" });
  await controller.enqueue({ text: "good" });
  shutdown.abort();
  await controller.enqueue({ text: "after shutdown" });
  assert.equal(errors.length, 1);
  assert.deepEqual(played, ["good"]);
});
