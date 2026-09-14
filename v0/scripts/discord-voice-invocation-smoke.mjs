import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadDiscordVoiceConfig } from "../src/runtime/discord-voice/config.mjs";
import { createConversationEngine } from "../src/engine/conversation.mjs";
import { createOpenAIAudioAdapter } from "../src/providers/openai-audio.mjs";
import { createCodexBackend } from "../src/execution/codex/backend.mjs";
import { bindExecution } from "../src/execution/port.mjs";
import { ttsPcm24kMonoToDiscordRaw } from "../src/adapters/discord/audio-format.mjs";
import { wrapPcmAsWav } from "../src/engine/input/audio.mjs";

// Explicit paid smoke: real STT, TTS and Codex, with synthetic speech and a
// temporary repository. No Discord connection or messages to participants.
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "idd-invocation-smoke-"));
const source = join(root, "source");
await mkdir(source);
await writeFile(
  join(source, "AGENTS.md"),
  "This is a bounded voice integration test. For a greeting-file request, write greeting.txt containing こんにちは. Do not call external services, create agents, commit, or edit other files.\n",
);
await exec("git", ["init", "-q", source]);
await exec("git", ["-C", source, "add", "AGENTS.md"]);
await exec("git", [
  "-C",
  source,
  "-c",
  "user.name=Voice Smoke",
  "-c",
  "user.email=voice-smoke@example.invalid",
  "commit",
  "-qm",
  "fixture",
]);
const config = {
  ...loadDiscordVoiceConfig(),
  workingDirectory: source,
  isolatedCodexHome: join(root, "codex-home"),
  statePath: join(root, "codex.json"),
  taskWorkspaceDirectory: join(root, "workspaces"),
  allowedUserId: "synthetic-owner",
  powerMode: true,
  voiceMode: "meeting",
  immediateReactions: true,
  requireWakeWord: true,
  allParticipantsOperate: true,
  autonomousTasks: false,
};
const execution = bindExecution(createCodexBackend(config));
const audio = createOpenAIAudioAdapter(config);
let engine,
  outputBytes = 0;
const transcripts = [],
  events = [];
const wait = async (predicate, timeout = 180000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout)
      throw new Error("Invocation smoke timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};
try {
  await execution.prepare();
  engine = await createConversationEngine({
    config,
    audio: {
      ...audio,
      transcribe: async (...args) => {
        const text = await audio.transcribe(...args);
        transcripts.push(text);
        return text;
      },
    },
    execution,
    output: {
      capabilities: { audio: true },
      postText: async () => {},
      playAudio: async (pcm) => {
        outputBytes += pcm.length;
      },
    },
    dependencies: { scheduleInterval: () => ({}), cancelInterval: () => {} },
    logger: { info() {} },
    onEvent: (event) => events.push(event),
  });
  const input = async (text) => {
    const pcm = await audio.synthesize(text);
    assert.equal(
      engine.input.accept({
        type: "audio",
        audio: wrapPcmAsWav(ttsPcm24kMonoToDiscordRaw(pcm)),
        actor: { id: "synthetic-owner", name: "試験音声" },
      }),
      true,
    );
  };
  const started = Date.now();
  await input("あ、いどぼっと、聞こえていますか？");
  await wait(() => outputBytes > 9600, 30000);
  const replyMs = Date.now() - started;
  const repliesBeforeConversation = outputBytes;
  await input("今日はチェックリストの見た目を相談しています。");
  await wait(
    () => transcripts.length === 2 && engine.session.activeTranscriptions === 0,
  );
  assert.equal(
    outputBytes,
    repliesBeforeConversation,
    "ordinary speech remains quiet",
  );
  assert.equal(engine.taskQueue.list().length, 0);
  const requestedAt = Date.now();
  await input("いどぼっと、挨拶文のテキストファイルを作ってください。");
  await wait(() => engine.taskQueue.list().length === 1, 30000);
  const receiptMs = Date.now() - requestedAt;
  await wait(() =>
    ["completed", "failed"].includes(engine.taskQueue.list()[0]?.state),
  );
  const task = engine.taskQueue.list()[0];
  assert.equal(task.state, "completed");
  assert.match(
    await readFile(
      join(config.taskWorkspaceDirectory, task.id, "greeting.txt"),
      "utf8",
    ),
    /こんにちは/u,
  );
  assert.equal(engine.taskQueue.list().length, 1);
  console.log(
    JSON.stringify({
      passed: true,
      syntheticTranscripts: transcripts,
      replyIncludingInputTtsMs: replyMs,
      receiptIncludingInputTtsMs: receiptMs,
      taskElapsedMs: Date.now() - requestedAt,
      outputAudioBytes: outputBytes,
      execution: "real Codex",
      discordConnected: false,
      humanParticipantsTested: 0,
      stages: [...new Set(events.map((e) => e.stage))],
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      failed: true,
      syntheticTranscripts: transcripts,
      outputAudioBytes: outputBytes,
      tasks: engine?.taskQueue?.list(),
      events: events
        .slice(-20)
        .map(({ stage, status, reason }) => ({ stage, status, reason })),
    }),
  );
  throw error;
} finally {
  await Promise.allSettled([engine?.session.stop(), engine?.taskQueue?.stop()]);
  await execution.close();
  await rm(root, { recursive: true, force: true });
}
