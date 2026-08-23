import { stat } from "node:fs/promises";
import {
  describeDiscordVoiceConfig,
  loadDiscordVoiceConfig,
} from "./discord-voice-config.mjs";
import { voiceErrorCode } from "./discord-voice-errors.mjs";

const PUBLIC_REQUIRED_ENVIRONMENT = Object.freeze([
  "PERSONAL_CONTEXT_VOICE_GUILD_ID",
  "PERSONAL_CONTEXT_VOICE_CHANNEL_ID",
  "PERSONAL_CONTEXT_VOICE_TEXT_CHANNEL_ID",
  "PERSONAL_CONTEXT_VOICE_USER_ID",
  "PERSONAL_CONTEXT_VOICE_WORKDIR",
]);
const OPTIONAL_VOICE_ENVIRONMENT = Object.freeze([
  "PERSONAL_CONTEXT_VOICE_STATE_PATH",
  "PERSONAL_CONTEXT_VOICE_STT_MODEL",
  "PERSONAL_CONTEXT_VOICE_TTS_MODEL",
  "PERSONAL_CONTEXT_VOICE_TTS_VOICE",
  "PERSONAL_CONTEXT_VOICE_CODEX_MODEL",
  "PERSONAL_CONTEXT_VOICE_CODEX_HOME",
  "PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME",
  "PERSONAL_CONTEXT_VOICE_CODEX_SANDBOX",
  "PERSONAL_CONTEXT_VOICE_SILENCE_MS",
  "PERSONAL_CONTEXT_VOICE_MINIMUM_AUDIO_MS",
  "PERSONAL_CONTEXT_VOICE_MAXIMUM_AUDIO_SECONDS",
  "PERSONAL_CONTEXT_VOICE_MAXIMUM_QUEUE",
  "PERSONAL_CONTEXT_VOICE_STT_TIMEOUT_MS",
  "PERSONAL_CONTEXT_VOICE_CODEX_TIMEOUT_MS",
  "PERSONAL_CONTEXT_VOICE_DISCORD_TIMEOUT_MS",
  "PERSONAL_CONTEXT_VOICE_TTS_TIMEOUT_MS",
  "PERSONAL_CONTEXT_VOICE_PLAYBACK_TIMEOUT_MS",
]);
const CONFIGURATION_ENVIRONMENT = Object.freeze([
  ...PUBLIC_REQUIRED_ENVIRONMENT,
  ...OPTIONAL_VOICE_ENVIRONMENT,
  "OPENAI_API_KEY",
]);
const OFFLINE_API_KEY_PLACEHOLDER = "offline-diagnostic-placeholder";
const GUIDANCE = Object.freeze({
  REQUIRED_ENVIRONMENT_MISSING: Object.freeze({
    message: "必須の環境変数が設定されていません。",
    action: ".env.exampleを参照し、fieldsの環境変数を設定してください。",
  }),
  CONFIG_INVALID: Object.freeze({
    message: "Discord音声設定に許容範囲外の値があります。",
    action: ".env.exampleとMVP仕様を参照して設定値を修正してください。",
  }),
  BOT_CREDENTIAL_MISSING: Object.freeze({
    message: "専用Discord Bot資格情報を確認できません。",
    action:
      "リポジトリ外の資格情報ストアを設定して完全診断を再実行してください。",
  }),
  WORKING_DIRECTORY_UNAVAILABLE: Object.freeze({
    message: "Codex作業ディレクトリをdirectoryとして確認できません。",
    action: "絶対パスとWSLからのアクセス権を確認してください。",
  }),
  CODEX_ISOLATION_UNAVAILABLE: Object.freeze({
    message: "安全な隔離CODEX_HOMEを準備できません。",
    action: "認証元、隔離先、状態directoryの権限を確認してください。",
  }),
});

function createIssue(code, detail = {}) {
  return { code, ...GUIDANCE[code], ...detail };
}

function configurationField(error) {
  if (typeof error?.message !== "string") return undefined;
  return CONFIGURATION_ENVIRONMENT.find((name) => error.message.includes(name));
}

function copyConfigurationEnvironment(env, mode) {
  const copied = {};
  for (const name of [
    ...PUBLIC_REQUIRED_ENVIRONMENT,
    ...OPTIONAL_VOICE_ENVIRONMENT,
  ]) {
    if (env[name] !== undefined) copied[name] = env[name];
  }
  copied.OPENAI_API_KEY =
    mode === "offline" ? OFFLINE_API_KEY_PLACEHOLDER : env.OPENAI_API_KEY;
  return copied;
}

async function prepareCodexByDefault(config) {
  const { CodexVoiceRunner } = await import("./discord-voice-openai.mjs");
  const codex = new CodexVoiceRunner(config);
  await codex.prepare();
}

async function readCredentialByDefault() {
  const { readDiscordTokenStore } = await import("./discord-config.mjs");
  return readDiscordTokenStore();
}

export async function inspectDiscordVoiceReadiness({
  mode = "full",
  env = process.env,
  readCredential = readCredentialByDefault,
  statPath = stat,
  loadConfig = loadDiscordVoiceConfig,
  describeConfig = describeDiscordVoiceConfig,
  prepareCodex = prepareCodexByDefault,
} = {}) {
  if (!new Set(["offline", "full"]).has(mode)) {
    throw new TypeError("mode must be offline or full");
  }

  const checks = {
    botCredential: mode === "offline" ? "skipped" : "pending",
    openaiApiKey: mode === "offline" ? "skipped" : "pending",
    configuration: "pending",
    workingDirectory: "pending",
    codexIsolation: mode === "offline" ? "skipped" : "pending",
  };
  const issues = [];

  if (mode === "full") {
    try {
      await readCredential();
      checks.botCredential = "passed";
    } catch {
      checks.botCredential = "failed";
      issues.push(createIssue("BOT_CREDENTIAL_MISSING"));
    }
  }

  const requiredEnvironment =
    mode === "offline"
      ? PUBLIC_REQUIRED_ENVIRONMENT
      : [...PUBLIC_REQUIRED_ENVIRONMENT, "OPENAI_API_KEY"];
  const missingEnvironment = requiredEnvironment.filter(
    (name) => typeof env[name] !== "string" || !env[name].trim(),
  );
  if (mode === "full") {
    checks.openaiApiKey = missingEnvironment.includes("OPENAI_API_KEY")
      ? "failed"
      : "passed";
  }

  let config;
  let configDescription;
  if (missingEnvironment.length) {
    checks.configuration = "failed";
    checks.workingDirectory = "skipped";
    if (mode === "full") checks.codexIsolation = "skipped";
    issues.push(
      createIssue("REQUIRED_ENVIRONMENT_MISSING", {
        fields: missingEnvironment,
      }),
    );
  } else {
    try {
      const loaded = loadConfig(copyConfigurationEnvironment(env, mode));
      const candidate =
        mode === "offline" ? { ...loaded, openaiApiKey: undefined } : loaded;
      const candidateDescription = describeConfig(candidate);
      config = candidate;
      configDescription = candidateDescription;
      checks.configuration = "passed";
    } catch (error) {
      checks.configuration = "failed";
      checks.workingDirectory = "skipped";
      if (mode === "full") checks.codexIsolation = "skipped";
      const field = configurationField(error);
      issues.push(createIssue("CONFIG_INVALID", field ? { field } : undefined));
    }
  }

  if (config) {
    try {
      const workingDirectory = await statPath(config.workingDirectory);
      if (!workingDirectory.isDirectory())
        throw new TypeError("not a directory");
      checks.workingDirectory = "passed";
    } catch {
      checks.workingDirectory = "failed";
      issues.push(createIssue("WORKING_DIRECTORY_UNAVAILABLE"));
    }

    if (mode === "full") {
      try {
        await prepareCodex(config);
        checks.codexIsolation = "passed";
      } catch (error) {
        checks.codexIsolation = "failed";
        issues.push(
          createIssue("CODEX_ISOLATION_UNAVAILABLE", {
            causeCode: voiceErrorCode(error),
          }),
        );
      }
    }
  }

  const ready =
    mode === "offline"
      ? checks.configuration === "passed" &&
        checks.workingDirectory === "passed"
      : Object.values(checks).every((status) => status === "passed");

  return {
    mode,
    ready,
    serviceReady: mode === "full" && ready,
    botCredential: checks.botCredential === "passed",
    configuration: checks.configuration === "passed",
    workingDirectory: checks.workingDirectory === "passed",
    codexIsolation: checks.codexIsolation === "passed",
    checks,
    issues,
    ...(configDescription ? { config: configDescription } : {}),
  };
}
