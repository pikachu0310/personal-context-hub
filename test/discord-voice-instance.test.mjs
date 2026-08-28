import assert from "node:assert/strict";
import test from "node:test";
import { buildDiscordVoiceInstanceCommand } from "../scripts/discord-voice-instance.mjs";

test("voice instance commands layer one ignored profile over the base env", () => {
  const launch = buildDiscordVoiceInstanceCommand({
    command: "start",
    profile: "tdm-wisdom",
    workingDirectory: "/srv/voice-bot",
  });
  assert.equal(launch.profilePath, "/srv/voice-bot/.env.voice.tdm-wisdom");
  assert.deepEqual(launch.arguments, [
    "--env-file-if-exists=/srv/voice-bot/.env",
    "--env-file=/srv/voice-bot/.env.voice.tdm-wisdom",
    "/srv/voice-bot/src/discord-voice-server.mjs",
  ]);
});

test("voice instance auth forwards only explicit arguments", () => {
  const launch = buildDiscordVoiceInstanceCommand({
    command: "auth",
    profile: "tdm",
    extraArguments: ["--application-id", "11111111111111111"],
    workingDirectory: "/srv/voice-bot",
  });
  assert.deepEqual(launch.arguments.slice(-3), [
    "/srv/voice-bot/scripts/store-discord-token.mjs",
    "--application-id",
    "11111111111111111",
  ]);
});

test("voice instance profiles reject paths and ambiguous names", () => {
  for (const profile of ["../escape", "TDM", "", "a".repeat(65)]) {
    assert.throws(
      () =>
        buildDiscordVoiceInstanceCommand({
          command: "inspect",
          profile,
          workingDirectory: "/srv/voice-bot",
        }),
      /Profile must use/,
    );
  }
});
