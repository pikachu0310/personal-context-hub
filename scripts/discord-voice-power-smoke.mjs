import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadDiscordVoiceConfig } from "../src/discord-voice-config.mjs";
import { CodexVoiceRunner } from "../src/discord-voice-openai.mjs";

const base = loadDiscordVoiceConfig();
const temporaryDirectory = await mkdtemp(join(tmpdir(), "voice-power-smoke-"));
const markerPath = join(temporaryDirectory, "marker.txt");

try {
  const runner = new CodexVoiceRunner({
    ...base,
    workingDirectory: resolve(process.argv[2] ?? process.cwd()),
    statePath: join(temporaryDirectory, "observer-thread.json"),
    isolatedCodexHome: join(temporaryDirectory, "isolated-codex-home"),
    voiceMode: "meeting",
    powerMode: true,
    codexSandbox: "danger-full-access",
  });
  const response = await runner.runTask({
    title: "Power mode smoke",
    request: [
      `作業directory外の ${JSON.stringify(markerPath)} に VOICE_POWER_FILE_OK と書き、読み戻してください。`,
      "https://developers.openai.com/codex/ へネットワークで到達できることを確認してください。",
      "可能ならlive Web検索も1回使用してください。ほかのファイルや外部状態は変更しないでください。",
      "すべて成功したら最終応答に VOICE_POWER_TASK_OK を含めてください。",
    ].join(" "),
    context: "自動smoke test。marker以外の変更は禁止。",
  });
  const marker = await readFile(markerPath, "utf8");
  if (marker.trim() !== "VOICE_POWER_FILE_OK") {
    throw new Error("Power task did not write the expected marker.");
  }
  if (!response.includes("VOICE_POWER_TASK_OK")) {
    throw new Error("Power task did not return the expected marker.");
  }
  console.log(
    JSON.stringify({
      marker: "VOICE_POWER_TASK_OK",
      unrestrictedFileWrite: true,
      networkRequested: true,
    }),
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
