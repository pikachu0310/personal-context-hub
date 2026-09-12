import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  CodexVoiceRunner,
  createOpenAIAudioAdapter,
} from "../src/discord-voice-openai.mjs";
import { loadDiscordVoiceConfig } from "../src/discord-voice-config.mjs";
import { ttsPcm24kMonoToDiscordRaw } from "../src/discord-voice-audio.mjs";
import {
  subscribeToAllowedSpeaker,
  createDiscordArtifactPoster,
  createDiscordMessagePayload,
} from "../src/discord-voice-server.mjs";
import {
  DiscordVoiceMeetingSession,
  DiscordVoiceTaskQueue,
} from "../src/discord-voice-session.mjs";
import { MeetingStateStore } from "../src/discord-voice-state.mjs";

// Uses real Codex and speech APIs with synthetic input in a temporary repository.
// Discord transport and audio playback are simulated; no participant is recorded.
const exec = promisify(execFile);
const noop = async () => undefined;
const config = loadDiscordVoiceConfig();
const root = await mkdtemp(join(tmpdir(), "idobata-conversation-smoke-"));
const repository = join(root, "fixture");
const reportPath = join(root, "report.json");
const originalSource = "export const add = (a, b) => a - b;\n";
const originalTests =
  'import test from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "./math.mjs";\ntest("addition", () => { assert.equal(add(2, 3), 5); assert.equal(add(-2, 3), 1); });\n';
await mkdir(repository);
await writeFile(join(repository, "math.mjs"), originalSource);
await writeFile(join(repository, "math.test.mjs"), originalTests);
await writeFile(
  join(repository, "README.md"),
  "# Synthetic calculator\nFix math.mjs; preserve math.test.mjs. Run node --test math.test.mjs as a standalone command.\n",
);
for (const args of [
  ["init"],
  ["add", "math.mjs", "math.test.mjs", "README.md"],
  [
    "-c",
    "user.name=Idobata Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "synthetic conversation fixture",
  ],
])
  await exec("git", ["-C", repository, ...args]);

const runner = new CodexVoiceRunner({
  workingDirectory: repository,
  taskWorkspaceDirectory: join(root, "workspaces"),
  isolatedCodexHome: join(root, "codex-home"),
  statePath: join(root, "observer.json"),
  codexHome: config.codexHome,
  powerMode: true,
  voiceMode: "meeting",
  codexModel: config.codexModel,
  codexReasoningEffort: config.codexReasoningEffort,
  taskModel: config.taskModel,
  taskReasoningEffort: config.taskReasoningEffort,
  complexTaskModel: config.complexTaskModel,
  complexTaskReasoningEffort: config.complexTaskReasoningEffort,
  observerModel: config.observerModel,
  observerReasoningEffort: config.observerReasoningEffort,
  allowedUserId: "operator",
});
const audio = createOpenAIAudioAdapter({ ...config, ttsSpeed: 1 });
const store = new MeetingStateStore(
  join(root, "meeting.json"),
  "synthetic conversation",
);
const report = {
  realCodex: true,
  realSpeechAPI: true,
  discordConnected: false,
  audioPlayback: "simulated",
  reportPath,
  checks: {},
  observationElapsedMs: [],
};
const posts = [],
  artifactPosts = [],
  spoken = [],
  played = [];
const acceptedNonces = new Map();
let lostAcknowledgement = false;
let currentCheck;
let session;
const postText = async (text, options) => {
  const payload = createDiscordMessagePayload(text, options);
  if (payload.nonce && acceptedNonces.has(payload.nonce))
    return acceptedNonces.get(payload.nonce);
  posts.push(payload);
  if (payload.nonce) acceptedNonces.set(payload.nonce, payload);
  if (!lostAcknowledgement && options?.idempotencyKey?.includes(":reply:")) {
    lostAcknowledgement = true;
    throw new Error(
      "Synthetic lost acknowledgement after Discord accepted the answer",
    );
  }
  return payload;
};
const tasks = new DiscordVoiceTaskQueue({
  logger: {},
  postText,
  taskTimeoutMs: 180_000,
  checkpoint: (savedTasks) => store.save({ tasks: savedTasks }),
  runTask: (task, options) => runner.runTask(task, options),
  applyTask: (task) => runner.applyTask(task),
  onResult: (result, options) => session.addTaskResult(result, options),
  createTaskThread: async (task) => ({
    threadId: task.id,
    post: noop,
    update: noop,
    postArtifacts: createDiscordArtifactPoster(
      { send: async (payload) => artifactPosts.push(payload) },
      task,
    ),
  }),
});
const createSession = (initialState = {}) =>
  new DiscordVoiceMeetingSession({
    logger: {},
    initialState,
    ownerUserId: "operator",
    tasksEnabled: true,
    requireWakeWord: true,
    immediateReactions: false,
    transcribe: audio.transcribe,
    observe: async (context, options) => {
      const startedAt = Date.now();
      const result = await runner.observeMeeting(context, options);
      report.observationElapsedMs.push(Date.now() - startedAt);
      return result;
    },
    getTasks: () => tasks.list(),
    getTaskReceipt: (key) => tasks.getReceipt(key),
    getTaskResult: (id) => tasks.getTaskResult(id),
    controlTask: (control) => tasks.handleVoiceControlDurable(control),
    enqueueTask: (task) => tasks.enqueueDurable(task),
    checkpoint: (meeting) => store.save({ meeting }),
    upsertLiveTranscript: noop,
    upsertMinutes: noop,
    postText,
    synthesize: async (text, options) => {
      spoken.push(text);
      return audio.synthesize(text, options);
    },
    playAudio: async (bytes) => {
      assert.ok(bytes.length > 0);
      played.push(bytes.length);
    },
    stageTimeouts: {
      transcribing: 30_000,
      running_codex: 60_000,
      synthesizing: 30_000,
    },
    scheduleInterval: () => 0,
    cancelInterval: () => {},
  });
async function until(check, timeoutMs = 200_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail("Conversation smoke timed out");
}
async function check(name, action) {
  currentCheck = name;
  console.log(`Checking: ${name}`);
  await action();
  report.checks[name] = "passed";
}
try {
  await store.acquire();
  await store.load();
  await runner.prepare();
  session = createSession();
  await session.addText(
    "今回の対象は一時repoの計算関数です。修正対象はmath.mjsだけ。既存テストmath.test.mjsの書き換えや外部操作、commitは不要です。",
    { userId: "operator", taskEligible: false },
  );
  await check("speechToAuthorizedTask", async () => {
    const generated = await audio.synthesize(
      "いどぼっと、計算のバグを修正して、既存のテストを実行してください。",
      { signal: AbortSignal.timeout(30_000) },
    );
    const speaking = new EventEmitter(),
      decoder = new EventEmitter(),
      opus = new EventEmitter();
    decoder.destroy = noop;
    opus.destroy = noop;
    opus.pipe = () => decoder;
    subscribeToAllowedSpeaker({
      connection: { receiver: { speaking, subscribe: () => opus } },
      config: {
        voiceMode: "meeting",
        allowedUserId: "operator",
        minimumAudioMs: 250,
        maximumAudioSeconds: 90,
        silenceMs: 1000,
      },
      session,
      postText,
      logger: {},
      createDecoder: () => decoder,
    });
    speaking.emit("start", "operator");
    decoder.emit("data", ttsPcm24kMonoToDiscordRaw(generated));
    decoder.emit("end");
    await until(
      () =>
        session.activeTranscriptions === 0 && session.statements.length === 2,
      45_000,
    );
    report.recognizedRequest = session.statements[1].text;
    assert.equal(tasks.list().length, 0);
    assert.equal(await session.observeNow(), true);
    assert.equal(tasks.list().length, 1);
  });
  let task;
  await check("implementationAndIndependentTests", async () => {
    await until(() => tasks.active === 0 && session.results.length === 1);
    task = tasks.snapshot()[0];
    assert.equal(task.state, "completed");
    assert.equal(task.artifacts.status.trim(), "M\tmath.mjs");
    assert.equal(
      await readFile(join(task.workingDirectory, "math.test.mjs"), "utf8"),
      originalTests,
    );
    const result = await exec(process.execPath, ["--test", "math.test.mjs"], {
      cwd: task.workingDirectory,
    });
    const verified = task.evidence.tests.filter(
      (entry) => entry.command === "node --test",
    );
    assert.equal(verified.at(-1)?.outcome, "passed");
    assert.equal(
      (await exec("git", ["-C", repository, "status", "--porcelain"])).stdout,
      "",
    );
    report.verification = task.evidence;
    report.independentTestOutput = result.stdout;
  });
  await check("artifactReturn", async () => {
    assert.equal(artifactPosts.length, 1);
    assert.equal(artifactPosts[0].files.length, 2);
    assert.equal(artifactPosts[0].enforceNonce, true);
  });
  await check("resultQuestionAndReplyRecovery", async () => {
    await session.addText(
      "井戸Bot、いまの仕事で何を直し、テストはどうなったか短く教えてください。",
      { userId: "operator", taskEligible: false },
    );
    assert.equal(await session.observeNow(), true);
    assert.equal(tasks.list().length, 1);
    assert.equal(lostAcknowledgement, true);
    assert.equal(
      session.pendingControls.filter((control) => control.type === "reply")
        .length,
      1,
    );
    const observations = report.observationElapsedMs.length;
    const sent = posts.length;
    await session.stop();
    const saved = JSON.parse(
      await readFile(join(root, "meeting.json"), "utf8"),
    );
    session = createSession(saved.meeting);
    await session.observeNow();
    assert.equal(session.pendingControls.length, 0);
    assert.equal(posts.length, sent);
    assert.equal(report.observationElapsedMs.length, observations);
    assert.match(
      spoken.at(-1),
      /math\.mjs/,
      "Result answer must identify the corrected file",
    );
    assert.match(
      spoken.at(-1),
      /成功|passed|終了コード\s*0/i,
      "Result answer must explain the verified test outcome",
    );
    assert.equal(played.length, spoken.length);
    report.synthesizedReplies = played.length;
  });
  await check("explicitApply", async () => {
    assert.equal(
      await readFile(join(repository, "math.mjs"), "utf8"),
      originalSource,
    );
    assert.equal(
      await tasks.applyTask(task.id, task.artifacts.runRevision),
      true,
    );
    assert.equal(
      await readFile(join(repository, "math.test.mjs"), "utf8"),
      originalTests,
    );
    await exec(process.execPath, ["--test", "math.test.mjs"], {
      cwd: repository,
    });
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = { name: error.name, code: error.code };
  if (error.code === "ERR_ASSERTION")
    report.error.message = error.message.slice(0, 500);
  report.failedCheck = currentCheck ?? "setup";
  process.exitCode = 1;
} finally {
  const cleanup = await Promise.allSettled([session?.stop(), tasks.stop()]);
  try {
    await store.release();
  } catch {
    report.cleanup = "failed";
    process.exitCode = 1;
  }
  if (cleanup.some((result) => result.status === "rejected")) {
    report.cleanup = "failed";
    process.exitCode = 1;
  }
  if (process.exitCode) report.status = "failed";
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report, null, 2));
}
