import { inspectDiscordVoiceReadiness } from "../src/discord-voice-diagnostics.mjs";

const arguments_ = process.argv.slice(2);
if (
  arguments_.length > 1 ||
  arguments_.some((argument) => argument !== "--offline")
) {
  console.error("Usage: inspect-discord-voice-config.mjs [--offline]");
  process.exitCode = 2;
} else {
  const readiness = await inspectDiscordVoiceReadiness({
    mode: arguments_.includes("--offline") ? "offline" : "full",
  });

  console.log(JSON.stringify(readiness, null, 2));
  if (!readiness.ready) process.exitCode = 1;
}
