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
  PERSONAL_CONTEXT_VOICE_CODEX_HOME: "/mnt/c/Users/example/.codex",
  OPENAI_API_KEY: "test-secret-never-print",
};

test("voice config validates Discord targets and redacts the OpenAI key", () => {
  const config = loadDiscordVoiceConfig(valid);
  assert.equal(config.silenceMs, 1_000);
  assert.equal(config.maximumAudioSeconds, 90);
  assert.equal(config.listenToEveryone, false);
  assert.equal(config.ttsSpeed, 1);
  assert.equal(config.codexHome, "/mnt/c/Users/example/.codex");
  assert.match(
    config.isolatedCodexHome,
    /personal-context-hub\/discord-voice-codex-home$/,
  );
  assert.equal(config.stageTimeouts.running_codex, 900_000);
  const description = describeDiscordVoiceConfig(config);
  assert.equal(description.openaiApiKeyConfigured, true);
  assert.equal(description.codexHomeConfigured, true);
  assert.equal(description.isolatedCodexHomeConfigured, true);
  assert.equal(description.codexHome, undefined);
  assert.equal(description.isolatedCodexHome, undefined);
  assert.doesNotMatch(JSON.stringify(description), /test-secret/);
  assert.doesNotMatch(JSON.stringify(description), /\/mnt\/c\/Users/);
});

test("voice config accepts all-speaker mode and TTS speed", () => {
  const config = loadDiscordVoiceConfig({
    ...valid,
    PERSONAL_CONTEXT_VOICE_LISTEN_TO_EVERYONE: "true",
    PERSONAL_CONTEXT_VOICE_TTS_SPEED: "2",
  });
  assert.equal(config.listenToEveryone, true);
  assert.equal(config.ttsSpeed, 2);
  const description = describeDiscordVoiceConfig(config);
  assert.equal(description.listenToEveryone, true);
  assert.equal(description.ttsSpeed, 2);
});

test("voice config rejects missing and malformed trust-boundary IDs", () => {
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_LISTEN_TO_EVERYONE: "yes",
      }),
    /true or false/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_TTS_SPEED: "4.1",
      }),
    /from 0.25 through 4/,
  );
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
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_CODEX_SANDBOX: "danger-full-access",
      }),
    /read-only or workspace-write/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_WORKDIR: "relative/project",
      }),
    /absolute path/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_CODEX_HOME: "relative/.codex",
      }),
    /absolute path/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME: "relative/isolated",
      }),
    /absolute path/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_STT_TIMEOUT_MS: "4999",
      }),
    /from 5000 through 600000/,
  );
});

test("voice config keeps the isolated Codex home beside an overridden state file", () => {
  const config = loadDiscordVoiceConfig({
    ...valid,
    PERSONAL_CONTEXT_VOICE_STATE_PATH: "/tmp/voice-state/thread.json",
  });
  assert.equal(
    config.isolatedCodexHome,
    "/tmp/voice-state/discord-voice-codex-home",
  );

  const explicit = loadDiscordVoiceConfig({
    ...valid,
    PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME: "/tmp/voice-codex-home",
  });
  assert.equal(explicit.isolatedCodexHome, "/tmp/voice-codex-home");
});
