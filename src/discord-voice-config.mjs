import { homedir } from "node:os";
import { join, resolve } from "node:path";

const snowflake = /^\d{17,20}$/;

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function requiredSnowflake(env, name) {
  const value = required(env, name);
  if (!snowflake.test(value))
    throw new Error(`${name} must be a Discord snowflake.`);
  return value;
}

function integer(env, name, fallback, minimum, maximum) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

export function loadDiscordVoiceConfig(env = process.env) {
  const workingDirectory = resolve(
    required(env, "PERSONAL_CONTEXT_VOICE_WORKDIR"),
  );
  const codexSandbox =
    env.PERSONAL_CONTEXT_VOICE_CODEX_SANDBOX?.trim() || "workspace-write";
  if (
    !new Set(["read-only", "workspace-write", "danger-full-access"]).has(
      codexSandbox,
    )
  ) {
    throw new Error(
      "PERSONAL_CONTEXT_VOICE_CODEX_SANDBOX must be read-only, workspace-write, or danger-full-access.",
    );
  }
  return {
    guildId: requiredSnowflake(env, "PERSONAL_CONTEXT_VOICE_GUILD_ID"),
    voiceChannelId: requiredSnowflake(env, "PERSONAL_CONTEXT_VOICE_CHANNEL_ID"),
    textChannelId: requiredSnowflake(
      env,
      "PERSONAL_CONTEXT_VOICE_TEXT_CHANNEL_ID",
    ),
    allowedUserId: requiredSnowflake(env, "PERSONAL_CONTEXT_VOICE_USER_ID"),
    workingDirectory,
    statePath: resolve(
      env.PERSONAL_CONTEXT_VOICE_STATE_PATH ??
        join(
          homedir(),
          ".local",
          "state",
          "personal-context-hub",
          "discord-voice-codex.json",
        ),
    ),
    sttModel: env.PERSONAL_CONTEXT_VOICE_STT_MODEL?.trim() || "gpt-transcribe",
    ttsModel: env.PERSONAL_CONTEXT_VOICE_TTS_MODEL?.trim() || "gpt-4o-mini-tts",
    ttsVoice: env.PERSONAL_CONTEXT_VOICE_TTS_VOICE?.trim() || "marin",
    codexModel: env.PERSONAL_CONTEXT_VOICE_CODEX_MODEL?.trim() || undefined,
    codexSandbox,
    silenceMs: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_SILENCE_MS",
      1_000,
      300,
      5_000,
    ),
    minimumAudioMs: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_MINIMUM_AUDIO_MS",
      250,
      100,
      5_000,
    ),
    maximumAudioSeconds: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_MAXIMUM_AUDIO_SECONDS",
      90,
      5,
      300,
    ),
    maximumQueuedTurns: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_MAXIMUM_QUEUE",
      3,
      1,
      10,
    ),
    openaiApiKey: required(env, "OPENAI_API_KEY"),
  };
}

export function describeDiscordVoiceConfig(config) {
  return {
    guildId: config.guildId,
    voiceChannelId: config.voiceChannelId,
    textChannelId: config.textChannelId,
    allowedUserId: config.allowedUserId,
    workingDirectory: config.workingDirectory,
    statePath: config.statePath,
    sttModel: config.sttModel,
    ttsModel: config.ttsModel,
    ttsVoice: config.ttsVoice,
    codexModel: config.codexModel ?? "Codex configured default",
    codexSandbox: config.codexSandbox,
    openaiApiKeyConfigured: Boolean(config.openaiApiKey),
  };
}
