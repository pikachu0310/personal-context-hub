import assert from "node:assert/strict";
import test from "node:test";
import {
  describeDiscordVoiceConfig,
  loadDiscordVoiceConfig,
} from "../src/discord-voice-config.mjs";

const valid = {
  PERSONAL_CONTEXT_VOICE_GUILD_ID: "11111111111111111",
  PERSONAL_CONTEXT_VOICE_CHANNEL_ID: "22222222222222222",
  PERSONAL_CONTEXT_VOICE_TEXT_CHANNEL_ID: "33333333333333333",
  PERSONAL_CONTEXT_VOICE_USER_ID: "44444444444444444",
  PERSONAL_CONTEXT_VOICE_WORKDIR: "/tmp/voice-workspace",
  OPENAI_API_KEY: "test-secret-never-print",
};

test("voice config validates Discord targets and redacts the OpenAI key", () => {
  const config = loadDiscordVoiceConfig(valid);
  assert.equal(config.silenceMs, 1_000);
  assert.equal(config.maximumAudioSeconds, 90);
  const description = describeDiscordVoiceConfig(config);
  assert.equal(description.openaiApiKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(description), /test-secret/);
});

test("voice config rejects missing and malformed trust-boundary IDs", () => {
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_USER_ID: "everyone",
      }),
    /snowflake/,
  );
  assert.throws(
    () => loadDiscordVoiceConfig({ ...valid, OPENAI_API_KEY: "" }),
    /OPENAI_API_KEY/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_MAXIMUM_QUEUE: "99",
      }),
    /from 1 through 10/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_CODEX_SANDBOX: "trust-me",
      }),
    /workspace-write/,
  );
});
