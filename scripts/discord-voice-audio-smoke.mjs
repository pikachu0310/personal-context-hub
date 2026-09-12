import assert from "node:assert/strict";
import { createOpenAIAudioAdapter } from "../src/discord-voice-openai.mjs";
import { wrapPcmAsWav } from "../src/discord-voice-audio.mjs";
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
const text = await audio.transcribe(
  wrapPcmAsWav(pcm, { sampleRate: 24_000, channels: 1 }),
  { signal: AbortSignal.timeout(30_000) },
);
assert.match(text, /ボタン/);
assert.match(text, /テスト/);
console.log(
  JSON.stringify(
    {
      syntheticSpeech: true,
      tts: "passed",
      stt: "passed",
      elapsedMs: Date.now() - startedAt,
      recognized: text,
      discordConnected: false,
    },
    null,
    2,
  ),
);
