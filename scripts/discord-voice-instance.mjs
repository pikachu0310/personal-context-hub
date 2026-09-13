import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const COMMAND_TARGETS = Object.freeze({
  auth: "scripts/store-discord-token.mjs",
  inspect: "scripts/inspect-discord-voice-config.mjs",
  start: "src/runtime/discord-voice/server.mjs",
});
const PROFILE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export function buildDiscordVoiceInstanceCommand({
  command,
  profile,
  extraArguments = [],
  workingDirectory = process.cwd(),
}) {
  if (!Object.hasOwn(COMMAND_TARGETS, command)) {
    throw new Error("Command must be auth, inspect, or start.");
  }
  if (!PROFILE_PATTERN.test(profile ?? "")) {
    throw new Error(
      "Profile must use 1-64 lowercase letters, numbers, hyphens, or underscores.",
    );
  }
  const profilePath = resolve(workingDirectory, `.env.voice.${profile}`);
  return {
    profilePath,
    arguments: [
      `--env-file-if-exists=${resolve(workingDirectory, ".env")}`,
      `--env-file=${profilePath}`,
      resolve(workingDirectory, COMMAND_TARGETS[command]),
      ...extraArguments,
    ],
  };
}

export async function runDiscordVoiceInstance({
  argv = process.argv.slice(2),
  workingDirectory = process.cwd(),
  spawnProcess = spawn,
} = {}) {
  const [command, profile, ...extraArguments] = argv;
  const launch = buildDiscordVoiceInstanceCommand({
    command,
    profile,
    extraArguments,
    workingDirectory,
  });
  if (!existsSync(launch.profilePath)) {
    throw new Error(`Voice instance profile not found: .env.voice.${profile}`);
  }
  const child = spawnProcess(process.execPath, launch.arguments, {
    cwd: workingDirectory,
    env: process.env,
    stdio: "inherit",
  });
  const forwardSignal = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", forwardSignal);
  process.once("SIGTERM", forwardSignal);
  try {
    return await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        resolveExit(signal ? 1 : (code ?? 1));
      });
    });
  } finally {
    process.removeListener("SIGINT", forwardSignal);
    process.removeListener("SIGTERM", forwardSignal);
  }
}

const isEntryPoint =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isEntryPoint) {
  try {
    process.exitCode = await runDiscordVoiceInstance();
  } catch (error) {
    console.error(error?.message ?? "Discord Voice instance command failed.");
    process.exitCode = 2;
  }
}
