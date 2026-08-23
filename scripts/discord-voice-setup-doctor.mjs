import { runDiscordVoiceSetupDoctor } from "../src/discord-voice-setup-doctor.mjs";

const arguments_ = process.argv.slice(2);
if (arguments_.length) {
  console.error("Usage: doctor:discord:voice");
  process.exitCode = 2;
} else {
  const report = await runDiscordVoiceSetupDoctor();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ready) process.exitCode = 1;
}
