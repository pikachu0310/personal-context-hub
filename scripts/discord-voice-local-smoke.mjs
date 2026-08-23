import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildCodexOptions,
  buildCodexPrompt,
  prepareIsolatedCodexHome,
} from "../src/discord-voice-openai.mjs";
import { DiscordVoiceSession } from "../src/discord-voice-session.mjs";

async function eventually(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error("Local voice smoke did not complete in time.");
}

const temporaryDirectory = await mkdtemp(
  join(tmpdir(), "discord-voice-local-smoke-"),
);
try {
  let sourceCodexHome;
  if (process.argv[2]) {
    sourceCodexHome = resolve(process.argv[2]);
  } else {
    sourceCodexHome = join(temporaryDirectory, "source-codex-home");
    await mkdir(sourceCodexHome);
    await writeFile(join(sourceCodexHome, "auth.json"), "{}\n", {
      mode: 0o600,
    });
  }

  const isolatedCodexHome = await prepareIsolatedCodexHome({
    sourceCodexHome,
    isolatedCodexHome: join(temporaryDirectory, "isolated-codex-home"),
  });
  assert.equal(
    (await lstat(join(isolatedCodexHome, "auth.json"))).isSymbolicLink(),
    true,
  );
  assert.equal(
    await realpath(join(isolatedCodexHome, "auth.json")),
    await realpath(join(sourceCodexHome, "auth.json")),
  );
  assert.equal(
    await readFile(join(isolatedCodexHome, "config.toml"), "utf8"),
    "",
  );

  const isolation = buildCodexOptions(process.env, isolatedCodexHome);
  assert.equal(isolation.config.features.apps, false);
  assert.equal(isolation.config.features.plugins, false);
  assert.deepEqual(isolation.config.mcp_servers, {});
  assert.equal(isolation.configOverrides, undefined);
  assert.match(buildCodexPrompt("ローカル確認"), /未信頼/);

  const cli = join(import.meta.dirname, "..", "node_modules", ".bin", "codex");
  const inspection = spawnSync(
    cli,
    ["mcp", "list", "--json", "--config", "mcp_servers={}"],
    {
      cwd: temporaryDirectory,
      encoding: "utf8",
      env: isolation.env,
      timeout: 10_000,
    },
  );
  assert.equal(inspection.status, 0, "Codex MCP isolation inspection failed");
  const parsed = JSON.parse(inspection.stdout);
  const servers = Array.isArray(parsed) ? parsed : Object.values(parsed);
  assert.equal(servers.length, 0);

  const calls = [];
  const session = new DiscordVoiceSession({
    transcribe: async () => (calls.push("stt"), "ローカル確認"),
    runCodex: async () => (calls.push("codex"), "確認完了"),
    postText: async () => calls.push("post"),
    synthesize: async () => (calls.push("tts"), Buffer.alloc(2)),
    playAudio: async () => calls.push("play"),
    logger: { info: () => undefined },
  });
  assert.equal(session.enqueue(Buffer.from("local-wav")), true);
  await eventually(() => session.state === "idle" && calls.includes("play"));
  assert.deepEqual(calls, ["stt", "post", "codex", "post", "tts", "play"]);

  console.log(
    JSON.stringify({
      marker: "VOICE_CODEX_LOCAL_OK",
      externalCalls: 0,
      isolatedCodexHome: true,
      configuredMcpServers: servers.length,
    }),
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
