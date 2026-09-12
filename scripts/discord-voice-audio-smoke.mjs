import assert from "node:assert/strict";
import { createOpenAIAudioAdapter } from "../src/discord-voice-openai.mjs";
import {
  wrapPcmAsWav,
  PcmSegmentBuffer,
  ttsPcm24kMonoToDiscordRaw,
} from "../src/discord-voice-audio.mjs";
import { DiscordVoiceMeetingSession } from "../src/discord-voice-session.mjs";
import { loadDiscordVoiceConfig } from "../src/discord-voice-config.mjs";

// Uses only synthetic speech. Never joins Discord or captures a participant.
const config = loadDiscordVoiceConfig();
const audio = createOpenAIAudioAdapter({ ...config, ttsSpeed: 1 });
const startedAt = Date.now();
const pcm = await audio.synthesize(
  "いどぼっと、青いボタンを実装して、テストを実行してください。",
  { signal: AbortSignal.timeout(30_000) },
);
assert.ok(pcm.length > 1000);
const correction = await audio.synthesize(
  "訂正します。ボタンの色は緑にしてください。",
  { signal: AbortSignal.timeout(30_000) },
);
const first = ttsPcm24kMonoToDiscordRaw(pcm);
const combined = Buffer.concat([
  first,
  Buffer.alloc(192_000 * 0.8),
  ttsPcm24kMonoToDiscordRaw(correction),
]);
const splitter = new PcmSegmentBuffer({
  minimumAudioMs: 250,
  maximumAudioSeconds: Math.ceil(first.length / 192_000 + 0.6),
});
const segments = splitter.push(combined);
const tail = splitter.finish();
if (tail) segments.push(tail);
assert.ok(segments.length >= 2);
assert.deepEqual(Buffer.concat(segments), combined);
const noop = async () => undefined;
const session = new DiscordVoiceMeetingSession({
  logger: {},
  transcribe: audio.transcribe,
  upsertLiveTranscript: noop,
  upsertMinutes: noop,
  postText: noop,
  synthesize: noop,
  playAudio: noop,
  scheduleInterval: () => 0,
  cancelInterval: () => {},
  stageTimeouts: { transcribing: 30_000 },
});
for (const [segmentIndex, segment] of segments.entries())
  session.enqueue(wrapPcmAsWav(segment), {
    userId: "synthetic-speaker",
    utteranceId: "synthetic-turn",
    segmentIndex,
  });
const deadline = Date.now() + 40_000;
while (
  Date.now() < deadline &&
  (session.activeTranscriptions || session.audioQueue.length)
)
  await new Promise((resolve) => setTimeout(resolve, 50));
assert.equal(session.statements.length, 0, "partial speech cannot start work");
await session.finishUtterance("synthetic-turn", segments.length);
const text = session.statements[0]?.text;
await session.stop();
assert.equal(session.statements[0].taskEligible, true);
assert.match(text, /ボタン/);
assert.match(text, /テスト/);
assert.match(text, /青[\s\S]*訂正[\s\S]*緑/);
console.log(
  JSON.stringify(
    {
      syntheticSpeech: true,
      tts: "passed",
      stt: "passed",
      segmentedSpeech: "passed",
      audioFramesPreserved: "passed",
      correctionOrderPreserved: "passed",
      segments: segments.length,
      elapsedMs: Date.now() - startedAt,
      recognized: text,
      discordConnected: false,
    },
    null,
    2,
  ),
);
