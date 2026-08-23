import { access } from "node:fs/promises";
import { readDiscordTokenStore } from "../src/discord-config.mjs";
import {
  describeDiscordVoiceConfig,
  loadDiscordVoiceConfig,
} from "../src/discord-voice-config.mjs";

const readiness = {
  ready: false,
  botCredential: false,
  configuration: false,
  workingDirectory: false,
  issues: [],
};
const requiredEnvironment = [
  "OPENAI_API_KEY",
  "PERSONAL_CONTEXT_VOICE_GUILD_ID",
  "PERSONAL_CONTEXT_VOICE_CHANNEL_ID",
  "PERSONAL_CONTEXT_VOICE_TEXT_CHANNEL_ID",
  "PERSONAL_CONTEXT_VOICE_USER_ID",
  "PERSONAL_CONTEXT_VOICE_WORKDIR",
];

try {
  await readDiscordTokenStore();
  readiness.botCredential = true;
} catch {
  readiness.issues.push(
    "Dedicated Discord Bot credential is not stored. Run npm run auth:discord first.",
  );
}

let config;
const missingEnvironment = requiredEnvironment.filter(
  (name) => !process.env[name]?.trim(),
);
if (missingEnvironment.length) {
  readiness.issues.push(
    `Missing environment variables: ${missingEnvironment.join(", ")}.`,
  );
} else {
  try {
    config = loadDiscordVoiceConfig();
    readiness.configuration = true;
    readiness.config = describeDiscordVoiceConfig(config);
  } catch (error) {
    readiness.issues.push(error.message);
  }
}

if (config) {
  try {
    await access(config.workingDirectory);
    readiness.workingDirectory = true;
  } catch {
    readiness.issues.push(
      "Configured Codex working directory is not accessible.",
    );
  }
}

readiness.ready =
  readiness.botCredential &&
  readiness.configuration &&
  readiness.workingDirectory;
console.log(JSON.stringify(readiness, null, 2));
if (!readiness.ready) process.exitCode = 1;
