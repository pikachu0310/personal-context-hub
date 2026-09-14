import assert from "node:assert/strict";
import test from "node:test";
import {
  SpeechActivityGate,
  pcmSignalRms,
} from "../src/runtime/audio-signal.js";
const voiced = Buffer.alloc(3840);
for (let i = 0; i < voiced.length; i += 2)
  voiced.writeInt16LE(Math.round(1200 * Math.sin(i / 17)), i);

test("1200ms of signal interrupts once, independent of decoder chunk boundaries", () => {
  let now = 0;
  const gate = new SpeechActivityGate(() => now);
  for (let i = 0; i < 59; i++) {
    now += 20;
    assert.equal(gate.push(voiced), false);
  }
  assert.equal(gate.push(voiced.subarray(0, 100)), false);
  assert.equal(gate.push(voiced.subarray(100)), true);
  for (let i = 0; i < 100; i++) assert.equal(gate.push(voiced), false);
  now += 1000;
  assert.equal(gate.silenceMs, 1000);
});
test("silence, DC, isolated clicks and stream-close delay never count as a long utterance", () => {
  let now = 0;
  const gate = new SpeechActivityGate(() => now);
  const dc = Buffer.alloc(3840);
  for (let i = 0; i < dc.length; i += 2) dc.writeInt16LE(2000, i);
  assert.equal(pcmSignalRms(dc), 0);
  for (let i = 0; i < 100; i++) {
    now += 20;
    assert.equal(gate.push(dc), false);
  }
  for (let i = 0; i < 4; i++) {
    now += 20;
    assert.equal(gate.push(voiced), false);
  }
  now += 1000; // Discord's AfterSilence timeout has no speech samples.
  assert.equal(gate.silenceMs, 1000);
  assert.equal(gate.push(voiced), false);
});
test("300ms silence and missing packets reset continuity, and subjects never share time", () => {
  let now = 0;
  const first = new SpeechActivityGate(() => now),
    second = new SpeechActivityGate(() => now);
  for (let i = 0; i < 40; i++) {
    now += 20;
    assert.equal(first.push(voiced), false);
    assert.equal(second.push(voiced), false);
  }
  for (let i = 0; i < 15; i++) {
    now += 20;
    assert.equal(first.push(Buffer.alloc(3840)), false);
  }
  for (let i = 0; i < 40; i++) {
    now += 20;
    assert.equal(first.push(voiced), false);
  }
  // Missing packets, rather than decoded silence, also reset the second track.
  assert.equal(second.push(voiced), false);
});
test("a pause shorter than 300ms is excluded from the accumulated voiced time", () => {
  const gate = new SpeechActivityGate(() => 0);
  for (let i = 0; i < 30; i++) assert.equal(gate.push(voiced), false);
  for (let i = 0; i < 10; i++)
    assert.equal(gate.push(Buffer.alloc(3840)), false);
  for (let i = 0; i < 29; i++) assert.equal(gate.push(voiced), false);
  assert.equal(gate.push(voiced), true);
});
