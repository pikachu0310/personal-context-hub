import { pcmSignalRms } from "@ido/common/runtime/audio-signal";
const WAV_HEADER_BYTES = 44;

// A conservative signal gate, not a speech recognizer: reject silence, DC and
// brief clicks before STT. Do not reject recognized words such as 「はい」.
export function qualifyTranscriptionAudio(wav) {
  if (
    !Buffer.isBuffer(wav) ||
    wav.length < 44 ||
    wav.toString("ascii", 0, 4) !== "RIFF" ||
    wav.toString("ascii", 36, 40) !== "data"
  )
    throw new Error("INVALID_PCM_WAV");
  const rate = wav.readUInt32LE(24);
  const channels = wav.readUInt16LE(22);
  if (
    wav.readUInt16LE(20) !== 1 ||
    wav.readUInt16LE(34) !== 16 ||
    !rate ||
    !channels
  )
    throw new Error("INVALID_PCM_WAV");
  const pcm = wav.subarray(44);
  const frameBytes = Math.max(
    channels * 2,
    Math.floor(rate * 0.02) * channels * 2,
  );
  let activeMs = 0;
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    const end = Math.min(pcm.length, offset + frameBytes);
    const rms = pcmSignalRms(pcm.subarray(offset, end));
    const samples = Math.floor((end - offset) / 2);
    if (rms >= 80) activeMs += (samples / channels / rate) * 1000;
  }
  return { accepted: activeMs >= 80, activeMs };
}

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

// Keep continuous meeting audio bounded without discarding an entire long turn.
// Prefer a quiet 100 ms window near the limit; every PCM frame is retained once.
export class PcmSegmentBuffer {
  constructor({ minimumAudioMs = 250, maximumAudioSeconds = 90 }) {
    this.minimumAudioMs = minimumAudioMs;
    this.maximumBytes =
      Math.floor((Math.min(maximumAudioSeconds, 90) * 192_000) / 4) * 4;
    if (this.maximumBytes < 4)
      throw new RangeError("audio segment limit is too small");
    this.chunks = [];
    this.byteLength = 0;
    this.segmentCount = 0;
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length % 4)
      throw new TypeError("PCM chunk must contain complete stereo frames");
    const complete = [];
    let offset = 0;
    while (offset < chunk.length) {
      const bytes = Math.min(
        chunk.length - offset,
        this.maximumBytes - this.byteLength,
      );
      this.chunks.push(chunk.subarray(offset, offset + bytes));
      this.byteLength += bytes;
      offset += bytes;
      if (this.byteLength !== this.maximumBytes) continue;
      const pcm = Buffer.concat(this.chunks, this.byteLength);
      const window = Math.min(19_200, Math.floor(pcm.length / 8) * 4);
      let boundary = pcm.length;
      for (
        let end = pcm.length;
        window && end >= Math.max(window, pcm.length - 192_000);
        end -= window
      ) {
        let peak = 0;
        for (let sample = end - window; sample < end; sample += 2)
          peak = Math.max(peak, Math.abs(pcm.readInt16LE(sample)));
        if (peak < 160) {
          boundary = end;
          break;
        }
      }
      complete.push(pcm.subarray(0, boundary));
      this.chunks =
        boundary < pcm.length ? [Buffer.from(pcm.subarray(boundary))] : [];
      this.byteLength = pcm.length - boundary;
      this.segmentCount++;
    }
    return complete;
  }

  finish() {
    const pcm = Buffer.concat(this.chunks, this.byteLength);
    this.chunks = [];
    this.byteLength = 0;
    if (
      !pcm.length ||
      (!this.segmentCount &&
        pcmDurationSeconds(pcm) * 1000 < this.minimumAudioMs)
    )
      return undefined;
    this.segmentCount++;
    return pcm;
  }
}
