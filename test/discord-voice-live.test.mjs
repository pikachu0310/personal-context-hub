import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { DiscordLiveBridge, LiveInputMixer } from "../src/providers/live.mjs";

test("Live mixes simultaneous Discord tracks on one clock, clips and bounds buffered audio", () => {
  const mixer = new LiveInputMixer({ maximumBufferedFrames: 1 });
  const pcm = Buffer.alloc(3840);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(24000, i);
  mixer.push("a", pcm.subarray(0, 7));
  mixer.push("a", pcm.subarray(7));
  mixer.push("b", pcm);
  const frame = mixer.frame();
  assert.equal(frame.length, 960);
  assert.equal(frame.readInt16LE(0), 32767);
  assert.equal(frame.readInt16LE(958), 32767);
  assert.deepEqual(mixer.frame(), Buffer.alloc(960));
  mixer.push("a", Buffer.concat([pcm, pcm, pcm]));
  assert.equal(mixer.droppedFrames, 2);
});

test("Live waits for startup, delegates metadata without inventing task text, stops speech and fails back on disconnect", async () => {
  const socket = new EventEmitter();
  const sent = [],
    output = [],
    delegations = [];
  let tick,
    clearCount = 0,
    closed = 0,
    fallback = 0;
  socket.send = (event) => sent.push(event);
  socket.close = () => socket.emit("close");
  const bridge = new DiscordLiveBridge({
    socketFactory: () => socket,
    scheduleInterval: (fn) => {
      tick = fn;
      return 1;
    },
    cancelInterval: () => {},
    logger: {},
    output: {
      append: (pcm) => output.push(pcm),
      clear: () => clearCount++,
      close: () => closed++,
    },
    onDelegation: (event) => delegations.push(event),
    onFailure: () => fallback++,
  });
  const starting = bridge.start();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].session.store, false);
  socket.emit("session.started", {});
  await starting;
  tick();
  assert.equal(sent[1].type, "session.input_audio.append");
  const audio = { delta: Buffer.alloc(960).toString("base64") };
  socket.emit("session.output_audio.delta", audio);
  assert.equal(output.length, 1);
  bridge.speakerStart("a");
  bridge.speakerStart("b");
  socket.emit("session.output_audio.delta", audio);
  bridge.speakerEnd("a");
  socket.emit("session.output_audio.delta", audio);
  assert.equal(output.length, 1);
  bridge.speakerEnd("b");
  bridge.silence();
  socket.emit("session.output_audio.delta", audio);
  assert.equal(output.length, 1);
  bridge.resume();
  socket.emit("session.output_audio.delta", audio);
  assert.equal(output.length, 2);
  assert.equal(clearCount, 3);
  socket.emit("session.delegation.created", {
    delegation: { id: "d1", target: "client" },
    offset_ms: 100,
  });
  assert.equal(delegations.length, 0, "wait for attributed STT");
  bridge.recordStatement({
    id: "meeting:1",
    meetingId: "meeting",
    sequence: 1,
    startedAt: bridge.startedAt,
    userId: "speaker-a",
    text: "調べて",
  });
  await new Promise(setImmediate);
  assert.equal(delegations.length, 1);
  assert.equal(delegations[0].text, undefined);
  assert.deepEqual(delegations[0].sourceSequences, [1]);
  assert.deepEqual(delegations[0].sourceIds, ["meeting:1"]);
  bridge.commentary("verified result", "d1");
  assert.equal(sent.at(-1).delegation_id, "d1");
  socket.emit("close");
  assert.equal(bridge.ready, false);
  assert.equal(closed, 1);
  assert.equal(fallback, 1);
  tick();
  bridge.close();
  assert.equal(closed, 1);
});

function fakeBridge(options = {}) {
  const socket = new EventEmitter();
  socket.send = () => {};
  socket.close = () => socket.emit("close");
  const bridge = new DiscordLiveBridge({
    socketFactory: () => socket,
    scheduleInterval: () => 1,
    cancelInterval() {},
    output: { append() {}, clear() {}, close() {} },
    logger: {},
    ...options,
  });
  return { bridge, socket };
}

test("Live delegation upgrades one attributed source once, including delayed STT", async () => {
  const notices = [];
  const { bridge, socket } = fakeBridge({
    onDelegation: (event) => notices.push(event),
  });
  const starting = bridge.start();
  socket.emit("session.started", {});
  await starting;
  const event = {
    delegation: { id: "delegation-1", target: "client" },
    offset_ms: 200,
  };
  socket.emit("session.delegation.created", event);
  socket.emit("session.delegation.created", event);
  await new Promise(setImmediate);
  assert.equal(notices.length, 0);
  bridge.recordStatement({
    id: "m:1",
    meetingId: "m",
    sequence: 1,
    startedAt: bridge.startedAt,
    text: "依頼",
    userId: "a",
  });
  bridge.recordStatement({
    id: "m:2",
    meetingId: "m",
    sequence: 2,
    startedAt: bridge.startedAt + 100,
    text: "続き",
    userId: "b",
  });
  await new Promise(setImmediate);
  assert.equal(notices.length, 1);
  assert.deepEqual(notices[0].sourceSequences, [1]);
  assert.equal(notices[0].meetingId, "m");
  assert.equal(bridge.metrics.delegations, 1);
  bridge.close();
});

test("Live logs exact assistant fragments and source intervals without claiming playback", async () => {
  const fragments = [];
  const { bridge, socket } = fakeBridge({
    onAssistantTranscript: (event) => fragments.push(event),
  });
  const starting = bridge.start();
  socket.emit("session.started", {});
  await starting;
  bridge.recordStatement({
    meetingId: "m",
    sequence: 1,
    startedAt: bridge.startedAt,
    text: "依頼",
    userId: "a",
  });
  bridge.silence();
  const event = {
    event_id: "transcript-1",
    delta: " 確認",
    start_ms: 100,
    end_ms: 250,
  };
  socket.emit("session.output_transcript.delta", event);
  socket.emit("session.output_transcript.delta", event);
  bridge.resume();
  socket.emit("session.output_transcript.delta", {
    event_id: "transcript-2",
    delta: "しました。",
    start_ms: 250,
    end_ms: 450,
  });
  await new Promise(setImmediate);
  assert.equal(fragments.length, 2);
  assert.equal(
    fragments.map((fragment) => fragment.text).join(""),
    " 確認しました。",
  );
  assert.equal(fragments[0].playbackStatus, "unknown");
  assert.equal(fragments[0].playbackSuppressedAtReceipt, true);
  assert.equal(fragments[1].playbackSuppressedAtReceipt, false);
  assert.equal(fragments[0].sourceStartMs, 100);
  assert.equal(fragments[0].sourceEndMs, 250);
  assert.equal(fragments[0].final, false);
  assert.equal(fragments[0].role, "assistant");
  assert.equal(fragments[0].meetingId, "m");
  assert.notEqual(fragments[0].id, fragments[1].id);
  bridge.close();
  socket.emit("session.output_transcript.delta", { delta: "late" });
  await new Promise(setImmediate);
  assert.equal(fragments.length, 2);
});

test("async Live socket construction can fail without loading Live for text mode", async () => {
  let closed = 0;
  const { bridge } = fakeBridge({
    socketFactory: async () => {
      throw new Error("Live SDK unavailable");
    },
    output: { close: () => closed++ },
  });
  await assert.rejects(bridge.start(), /Live SDK unavailable/);
  assert.equal(closed, 1);
  assert.equal(bridge.ready, false);
});

test("Live startup timeout closes transport and output without a background audio timer", async () => {
  const socket = new EventEmitter();
  socket.send = () => {};
  let closed = 0;
  socket.close = () => closed++;
  const bridge = new DiscordLiveBridge({
    socketFactory: () => socket,
    output: { close() {} },
    logger: {},
    scheduleInterval: () => assert.fail("must not start clock"),
  });
  await assert.rejects(bridge.start({ timeoutMs: 5 }), /timed out/);
  assert.equal(closed, 1);
});
