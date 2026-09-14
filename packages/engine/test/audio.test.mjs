import assert from "node:assert/strict";
import test from "node:test";
import { qualifyTranscriptionAudio, wrapPcmAsWav } from "../src/audio.mjs";

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
