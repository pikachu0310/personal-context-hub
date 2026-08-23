const WAV_HEADER_BYTES = 44;

export function wrapPcmAsWav(
  pcm,
  { sampleRate = 48_000, channels = 2, bitsPerSample = 16 } = {},
) {
  if (!Buffer.isBuffer(pcm)) throw new TypeError("pcm must be a Buffer");
  if (bitsPerSample !== 16)
    throw new Error("Only signed 16-bit PCM is supported.");
  const blockAlign = channels * (bitsPerSample / 8);
  if (pcm.length % blockAlign !== 0) {
    throw new Error("PCM length must contain complete sample frames.");
  }
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function ttsPcm24kMonoToDiscordRaw(pcm) {
  if (!Buffer.isBuffer(pcm)) throw new TypeError("pcm must be a Buffer");
  if (pcm.length % 2 !== 0)
    throw new Error("PCM must contain complete int16 samples.");
  const output = Buffer.alloc(pcm.length * 4);
  for (
    let inputOffset = 0, outputOffset = 0;
    inputOffset < pcm.length;
    inputOffset += 2
  ) {
    const sample = pcm.readInt16LE(inputOffset);
    // Nearest-neighbour 24 kHz mono -> 48 kHz stereo. Discord's raw voice
    // resource contract is signed 16-bit, 48 kHz, two channels.
    for (let duplicate = 0; duplicate < 2; duplicate += 1) {
      output.writeInt16LE(sample, outputOffset);
      output.writeInt16LE(sample, outputOffset + 2);
      outputOffset += 4;
    }
  }
  return output;
}

export function pcmDurationSeconds(
  pcm,
  { sampleRate = 48_000, channels = 2 } = {},
) {
  return pcm.length / (sampleRate * channels * 2);
}

export class PcmTurnBuffer {
  constructor({ minimumAudioMs, maximumAudioSeconds }) {
    this.minimumAudioMs = minimumAudioMs;
    this.maximumBytes = maximumAudioSeconds * 48_000 * 2 * 2;
    this.chunks = [];
    this.byteLength = 0;
    this.rejected = false;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk))
      throw new TypeError("PCM chunk must be a Buffer");
    if (this.rejected) return false;
    if (this.byteLength + chunk.length > this.maximumBytes) {
      this.rejected = true;
      this.chunks = [];
      this.byteLength = 0;
      return false;
    }
    this.chunks.push(chunk);
    this.byteLength += chunk.length;
    return true;
  }

  finish() {
    if (this.rejected) return { status: "too_long" };
    const pcm = Buffer.concat(this.chunks, this.byteLength);
    if (pcmDurationSeconds(pcm) * 1_000 < this.minimumAudioMs) {
      return { status: "too_short" };
    }
    return { status: "accepted", pcm };
  }
}
