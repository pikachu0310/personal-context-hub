import assert from "node:assert/strict";
import test from "node:test";
import {
  createConversationModeController,
  createLiveConversationMode,
  createTextSpeechConversationMode,
} from "../src/engine/conversation-mode.mjs";

test("switching conversation modes waits for previous speech and changes response ownership", async () => {
  const deliveries = [];
  let stopped;
  const textSpeech = createTextSpeechConversationMode({
    enqueueSpeech: (reply) => deliveries.push(["tts", reply]),
    stopSpeech: () => new Promise((resolve) => (stopped = resolve)),
  });
  const live = createLiveConversationMode({
    sendReply: (reply) => deliveries.push(["live", reply]),
  });
  const mode = createConversationModeController({ textSpeech });
  const reply = {
    id: "answer-1",
    text: "checked result",
    sourceSequences: [1],
  };
  await mode.routeReply(reply);
  assert.equal(mode.observationContext.voiceOwner, "coordinator");
  const selecting = mode.select(live);
  const delivering = mode.routeReply({ ...reply, id: "answer-2" });
  await Promise.resolve();
  assert.equal(mode.kind, "text-speech");
  assert.equal(deliveries.length, 1);
  stopped();
  await selecting;
  await delivering;
  assert.equal(mode.kind, "live");
  assert.equal(mode.observationContext.voiceOwner, "live");
  assert.equal(mode.suppressesLocalQuickReply, true);
  assert.deepEqual(
    deliveries.map(([owner]) => owner),
    ["tts", "live"],
  );
  assert.equal(deliveries[1][1].sourceSequences[0], 1);
});

test("mode change discards an answer generated for the previous ownership revision", async () => {
  const textSpeech = createTextSpeechConversationMode({
    enqueueSpeech: () => assert.fail("stale answer must not be spoken"),
  });
  const mode = createConversationModeController({ textSpeech });
  const revision = mode.revision;
  await mode.select(
    createLiveConversationMode({
      sendReply: () => assert.fail("stale answer must not be forwarded"),
    }),
  );
  assert.deepEqual(
    await mode.routeReply({ text: "old answer" }, { modeRevision: revision }),
    { status: "discarded", reason: "conversation_mode_changed" },
  );
});

test("Live hooks preserve attributed statements and unavailable Live never invokes TTS", async () => {
  const statements = [],
    states = [];
  let ready = true;
  const textSpeech = createTextSpeechConversationMode({
    enqueueSpeech: () => assert.fail("fallback must be selected explicitly"),
  });
  const mode = createConversationModeController({ textSpeech });
  await mode.select(
    createLiveConversationMode({
      isReady: () => ready,
      sendReply: () => assert.fail("unavailable provider"),
      observeStatement: (event) => statements.push(event),
      onTaskState: (tasks) => states.push(tasks),
    }),
  );
  const statement = {
    id: "m1:1",
    sequence: 1,
    userId: "speaker-a",
    text: "調べて",
  };
  const tasks = [{ id: "task-1", state: "running" }];
  mode.observeStatement(statement);
  mode.onTaskState(tasks);
  assert.equal(statements[0], statement);
  assert.equal(states[0], tasks);
  ready = false;
  assert.equal(mode.canDeliverReply(), false);
  assert.deepEqual(await mode.routeReply({ text: "answer" }), {
    status: "unavailable",
    reason: "conversation_mode_not_ready",
  });
});

test("a failed stop preserves the active mode and a later fallback can recover", async () => {
  let shouldFail = true;
  const textSpeech = createTextSpeechConversationMode({ enqueueSpeech() {} });
  const live = createLiveConversationMode({
    sendReply() {},
    stopSpeech() {
      if (shouldFail) throw new Error("player still active");
    },
  });
  const mode = createConversationModeController({
    textSpeech,
    initialMode: live,
  });
  await assert.rejects(mode.select(), /player still active/);
  assert.equal(mode.kind, "live");
  assert.equal(mode.revision, 0);
  shouldFail = false;
  await mode.select();
  assert.equal(mode.kind, "text-speech");
  assert.equal(mode.revision, 1);
});
