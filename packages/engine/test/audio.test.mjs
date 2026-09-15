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

test("STT rejects sub-100ms WAV files without rejecting 80ms of speech in a longer file", async () => {
  let calls = 0;
  const models = {
    transcribe: async () => {
      calls++;
      return "はい";
    },
  };
  for (const [durationMs, activeMs, expected] of [
    [80, 80, false],
    [99, 99, false],
    [100, 100, true],
    [200, 80, true],
  ]) {
    const pcm = Buffer.alloc(durationMs * 192);
    for (let i = 0; i < activeMs * 192; i += 4) {
      const sample = Math.round(
        1500 * Math.sin(((i / 4) * 2 * Math.PI * 440) / 48000),
      );
      pcm.writeInt16LE(sample, i);
      pcm.writeInt16LE(sample, i + 2);
    }
    const before = calls;
    assert.equal(
      await transcribe(models, wrapPcmAsWav(pcm)),
      expected ? "はい" : "",
    );
    assert.equal(calls - before, expected ? 1 : 0);
  }
});

test("inconsistent WAV headers and truncated sample frames are rejected before STT", async () => {
  const original = wrapPcmAsWav(Buffer.alloc(38400));
  const corrupt = [
    (wav) => {
      wav.write("NOPE", 8);
      return wav;
    },
    (wav) => {
      wav.writeUInt32LE(18, 16);
      return wav;
    },
    (wav) => {
      wav.writeUInt32LE(0, 4);
      return wav;
    },
    (wav) => {
      wav.writeUInt32LE(999, 40);
      return wav;
    },
    (wav) => {
      wav.writeUInt16LE(2, 32);
      return wav;
    },
    (wav) => {
      wav.writeUInt32LE(96000, 28);
      return wav;
    },
    (wav) => {
      const short = wav.subarray(0, wav.length - 1);
      short.writeUInt32LE(short.length - 8, 4);
      short.writeUInt32LE(short.length - 44, 40);
      return short;
    },
  ];
  for (const mutate of corrupt) {
    await assert.rejects(
      transcribe(
        {
          transcribe: async () => assert.fail("must not upload malformed WAV"),
        },
        mutate(Buffer.from(original)),
      ),
      /INVALID_PCM_WAV/,
    );
  }
});
