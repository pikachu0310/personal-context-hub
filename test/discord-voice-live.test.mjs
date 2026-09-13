import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  DiscordLiveBridge,
  LiveInputMixer,
} from "../src/discord-voice-live.mjs";

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
  assert.equal(delegations.length, 1);
  assert.equal(delegations[0].text, undefined);
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
