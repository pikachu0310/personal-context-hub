import assert from "node:assert/strict";
import test from "node:test";
import { transcribe } from "../src/input/audio/transcribe.ts";
import {
  qualifyTranscriptionAudio,
  wrapPcmAsWav,
} from "../src/input/audio/signal.mjs";

test("signal gate rejects silence/DC/clicks but retains short quiet signals", () => {
  const pcm = Buffer.alloc(192_000);
  assert.equal(qualifyTranscriptionAudio(wrapPcmAsWav(pcm)).accepted, false);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  assert.equal(qualifyTranscriptionAudio(wrapPcmAsWav(pcm)).accepted, false);
  pcm.fill(0);
  for (let i = 0; i < 1920; i += 2) pcm.writeInt16LE(i % 4 ? 20000 : -20000, i);
  assert.equal(qualifyTranscriptionAudio(wrapPcmAsWav(pcm)).accepted, false);
  pcm.fill(0);
  for (let i = 0; i < 38_400; i += 2)
    pcm.writeInt16LE(Math.round(200 * Math.sin(i / 15)), i);
  assert.equal(qualifyTranscriptionAudio(wrapPcmAsWav(pcm)).accepted, true);
});

test("STT only calls the provider for enough audio above the signal threshold", async () => {
  let calls = 0;
  const models = {
    async transcribe() {
      calls++;
      return "はい";
    },
  };
  for (const [amplitude, activeMs, expected] of [
    [0, 1000, false],
    [79, 1000, false],
    [20000, 20, false],
    [80, 60, false],
    [80, 80, true],
    [200, 100, true],
  ]) {
    const pcm = Buffer.alloc(192_000);
    for (let i = 0; i < activeMs * 192; i += 2)
      pcm.writeInt16LE(i % 4 ? amplitude : -amplitude, i);
    const before = calls;
    assert.equal(
      await transcribe(models, wrapPcmAsWav(pcm)),
      expected ? "はい" : "",
    );
    assert.equal(calls - before, expected ? 1 : 0);
  }
});
