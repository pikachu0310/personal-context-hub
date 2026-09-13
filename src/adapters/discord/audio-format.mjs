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
