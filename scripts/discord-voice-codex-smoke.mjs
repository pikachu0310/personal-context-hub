import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CodexVoiceRunner } from "../src/discord-voice-openai.mjs";

const workingDirectory = resolve(process.argv[2] ?? process.cwd());
const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "discord-voice-codex-smoke-"),
);
try {
  const runner = new CodexVoiceRunner({
    workingDirectory,
    statePath: join(temporaryDirectory, "thread.json"),
    codexSandbox: "read-only",
    codexModel: undefined,
  });
  const response = await runner.run(
    "疎通確認です。ファイルや外部状態を変更せず、VOICE_CODEX_SDK_OK とだけ返してください。",
  );
  if (!response.includes("VOICE_CODEX_SDK_OK")) {
    throw new Error(`Unexpected Codex SDK response: ${response.slice(0, 200)}`);
  }
  console.log(
    JSON.stringify({ codexSdk: true, response: "VOICE_CODEX_SDK_OK" }),
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
