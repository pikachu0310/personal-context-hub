import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

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

function number(env, name, fallback, minimum, maximum) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be a number from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

function boolean(env, name, fallback) {
  if (env[name] === undefined) return fallback;
  const value = env[name].trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function absolutePath(value, name) {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

export function loadDiscordVoiceConfig(env = process.env) {
  const workingDirectory = absolutePath(
    required(env, "PERSONAL_CONTEXT_VOICE_WORKDIR"),
    "PERSONAL_CONTEXT_VOICE_WORKDIR",
  );
  const statePath = resolve(
    env.PERSONAL_CONTEXT_VOICE_STATE_PATH ??
      join(
        homedir(),
        ".local",
        "state",
        "personal-context-hub",
        "discord-voice-codex.json",
      ),
  );
  const isolatedCodexHome =
    env.PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME?.trim()
      ? absolutePath(
          env.PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME,
          "PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME",
        )
      : join(dirname(statePath), "discord-voice-codex-home");
  const codexSandbox =
    env.PERSONAL_CONTEXT_VOICE_CODEX_SANDBOX?.trim() || "workspace-write";
  if (!new Set(["read-only", "workspace-write"]).has(codexSandbox)) {
    throw new Error(
      "PERSONAL_CONTEXT_VOICE_CODEX_SANDBOX must be read-only or workspace-write.",
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
    listenToEveryone: boolean(
      env,
      "PERSONAL_CONTEXT_VOICE_LISTEN_TO_EVERYONE",
      false,
    ),
    workingDirectory,
    statePath,
    sttModel: env.PERSONAL_CONTEXT_VOICE_STT_MODEL?.trim() || "gpt-transcribe",
    ttsModel: env.PERSONAL_CONTEXT_VOICE_TTS_MODEL?.trim() || "gpt-4o-mini-tts",
    ttsVoice: env.PERSONAL_CONTEXT_VOICE_TTS_VOICE?.trim() || "marin",
    ttsSpeed: number(env, "PERSONAL_CONTEXT_VOICE_TTS_SPEED", 1, 0.25, 4),
    codexModel: env.PERSONAL_CONTEXT_VOICE_CODEX_MODEL?.trim() || undefined,
    codexHome: env.PERSONAL_CONTEXT_VOICE_CODEX_HOME?.trim()
      ? absolutePath(
          env.PERSONAL_CONTEXT_VOICE_CODEX_HOME,
          "PERSONAL_CONTEXT_VOICE_CODEX_HOME",
        )
      : undefined,
    isolatedCodexHome,
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
    stageTimeouts: {
      transcribing: integer(
        env,
        "PERSONAL_CONTEXT_VOICE_STT_TIMEOUT_MS",
        120_000,
        5_000,
        600_000,
      ),
      running_codex: integer(
        env,
        "PERSONAL_CONTEXT_VOICE_CODEX_TIMEOUT_MS",
        900_000,
        30_000,
        3_600_000,
      ),
      posting: integer(
        env,
        "PERSONAL_CONTEXT_VOICE_DISCORD_TIMEOUT_MS",
        30_000,
        5_000,
        120_000,
      ),
      synthesizing: integer(
        env,
        "PERSONAL_CONTEXT_VOICE_TTS_TIMEOUT_MS",
        120_000,
        5_000,
        600_000,
      ),
      speaking: integer(
        env,
        "PERSONAL_CONTEXT_VOICE_PLAYBACK_TIMEOUT_MS",
        300_000,
        10_000,
        900_000,
      ),
    },
    openaiApiKey: required(env, "OPENAI_API_KEY"),
  };
}

export function describeDiscordVoiceConfig(config) {
  return {
    guildId: config.guildId,
    voiceChannelId: config.voiceChannelId,
    textChannelId: config.textChannelId,
    allowedUserId: config.allowedUserId,
    listenToEveryone: config.listenToEveryone,
    workingDirectory: config.workingDirectory,
    statePath: config.statePath,
    sttModel: config.sttModel,
    ttsModel: config.ttsModel,
    ttsVoice: config.ttsVoice,
    ttsSpeed: config.ttsSpeed,
    codexModel: config.codexModel ?? "Codex configured default",
    codexHomeConfigured: Boolean(config.codexHome),
    isolatedCodexHomeConfigured: Boolean(config.isolatedCodexHome),
    codexSandbox: config.codexSandbox,
    stageTimeouts: config.stageTimeouts,
    openaiApiKeyConfigured: Boolean(config.openaiApiKey),
  };
}
