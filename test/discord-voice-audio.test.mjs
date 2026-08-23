import assert from "node:assert/strict";
import test from "node:test";
import {
  pcmDurationSeconds,
  ttsPcm24kMonoToDiscordRaw,
  wrapPcmAsWav,
} from "../src/discord-voice-audio.mjs";

test("wrapPcmAsWav emits a complete PCM RIFF header", () => {
  const pcm = Buffer.alloc(48_000 * 2 * 2);
  const wav = wrapPcmAsWav(pcm);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 48_000);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.length, pcm.length + 44);
  assert.equal(pcmDurationSeconds(pcm), 1);
});

test("24 kHz mono TTS PCM is duplicated into 48 kHz stereo raw frames", () => {
  const mono = Buffer.alloc(4);
  mono.writeInt16LE(1_234, 0);
  mono.writeInt16LE(-2_345, 2);
  const stereo = ttsPcm24kMonoToDiscordRaw(mono);
  assert.deepEqual(
    Array.from({ length: 8 }, (_, index) => stereo.readInt16LE(index * 2)),
    [1_234, 1_234, 1_234, 1_234, -2_345, -2_345, -2_345, -2_345],
  );
});

test("audio helpers reject partial sample frames", () => {
  assert.throws(() => wrapPcmAsWav(Buffer.alloc(3)), /complete sample frames/);
  assert.throws(
    () => ttsPcm24kMonoToDiscordRaw(Buffer.alloc(1)),
    /complete int16/,
  );
});
