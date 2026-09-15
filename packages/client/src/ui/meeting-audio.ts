/** Convert a short browser recording into the Engine's mono 16 kHz WAV input. */
export async function meetingAudio(blob: Blob) {
  const context = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await context.decodeAudioData(await blob.arrayBuffer());
  } finally {
    await context.close();
  }
  if (decoded.duration > 12.5)
    throw new Error("録音が長すぎます。12秒以内に区切ってお話しください。");
  const samples = Math.max(
    1,
    Math.min(192000, Math.ceil(decoded.duration * 16000)),
  );
  const offline = new OfflineAudioContext(1, samples, 16000);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  const channel = rendered.getChannelData(0);
  const buffer = new ArrayBuffer(44 + channel.length * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, value: string) =>
    [...value].forEach((character, index) =>
      view.setUint8(offset + index, character.charCodeAt(0)),
    );
  ascii(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true);
  view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, channel.length * 2, true);
  channel.forEach((sample, index) =>
    view.setInt16(
      44 + index * 2,
      Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32768 : 32767),
      true,
    ),
  );
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}
