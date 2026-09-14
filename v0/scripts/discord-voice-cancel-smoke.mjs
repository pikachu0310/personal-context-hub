import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CodexVoiceRunner } from "../src/execution/codex/runner.mjs";
import { loadDiscordVoiceConfig } from "../src/runtime/discord-voice/config.mjs";
import { DiscordVoiceTaskQueue } from "../src/adapters/discord/sessions.mjs";
import { voiceErrorCode } from "../src/engine/errors.mjs";

// Real Codex, a disposable repository, and deliberately stalled Discord writes.
// No Discord connection, participant recording, or original-repository edits.
const config = loadDiscordVoiceConfig();
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "idobata-cancel-smoke-"));
const repository = join(root, "fixture");
const reportPath = join(root, "report.json");
const report = {
  realCodex: true,
  discordConnected: false,
  reportPath,
  checks: {},
};
let checking = "setup",
  tasks,
  releaseProgress,
  releaseNotice;
let progressSignal,
  noticeStarted = false,
  runs = 0,
  activeWorkers = 0,
  maximumActiveWorkers = 0;
const progress = new Promise((resolve) => {
  releaseProgress = resolve;
});
const notice = new Promise((resolve) => {
  releaseNotice = resolve;
});
const cards = [];
const waitUntil = async (condition, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("Smoke stage timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};
const check = async (name, operation) => {
  checking = name;
  console.log(`Checking: ${name}`);
  await operation();
  report.checks[name] = "passed";
};

try {
  await mkdir(repository);
  await writeFile(
    join(repository, "README.md"),
    "# Synthetic cancellation fixture\nOnly result.md may be changed. No external operations.\n",
  );
  for (const args of [
    ["init"],
    ["add", "README.md"],
    [
      "-c",
      "user.name=Idobata Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "synthetic fixture",
    ],
  ])
    await exec("git", ["-C", repository, ...args]);
  const runner = new CodexVoiceRunner({
    ...config,
    workingDirectory: repository,
    taskWorkspaceDirectory: join(root, "workspaces"),
    isolatedCodexHome: join(root, "codex-home"),
    statePath: join(root, "observer.json"),
    powerMode: true,
    voiceMode: "meeting",
  });
  await runner.prepare();
  tasks = new DiscordVoiceTaskQueue({
    logger: {},
    concurrency: 1,
    postText: async () => {},
    createTaskThread: async (task) => ({
      threadId: task.id,
      update: async ({ state }) => cards.push(state),
      post: async (content, { signal } = {}) => {
        if (runs === 1 && content === "🤖 Codexが作業を開始しました。") {
          progressSignal = signal;
          await progress;
        }
        if (content.includes("Codexタスク中止")) {
          noticeStarted = true;
          await notice;
        }
      },
    }),
    runTask: async (task, options) => {
      runs++;
      activeWorkers++;
      maximumActiveWorkers = Math.max(maximumActiveWorkers, activeWorkers);
      try {
        return await runner.runTask(task, options);
      } finally {
        activeWorkers--;
      }
    },
  });
  let id, firstThreadId;
  await check("cancelDuringStalledProgress", async () => {
    await tasks.enqueueDurable({
      title: "Synthetic cancellation check",
      kind: "implementation",
      request:
        "停止・再開の検証です。result.md に INITIAL と書いてください。この一時リポジトリ以外への操作は不要です。",
    });
    await waitUntil(() => progressSignal);
    id = tasks.list()[0].id;
    firstThreadId = tasks.tasks.get(id).codexThreadId;
    assert.ok(firstThreadId);
    const started = performance.now();
    const stopped = tasks.handleVoiceControlDurable({
      type: "stop",
      taskId: id,
      requestKey: "smoke:stop",
    });
    await waitUntil(
      () => activeWorkers === 0 && !tasks.tasks.get(id).executing,
      5_000,
    );
    assert.equal((await stopped).type, "cancelled");
    report.cancellationMs = Math.round(performance.now() - started);
    assert.equal(progressSignal.aborted, true);
    assert.equal(tasks.list()[0].state, "cancelled");
    await waitUntil(() => noticeStarted, 1_000);
  });
  await check("resumeBeforeCancellationNoticeCompletes", async () => {
    await tasks.handleVoiceControlDurable({
      type: "instruction",
      taskId: id,
      requestKey: "smoke:resume",
      instruction:
        "result.md を正確に RESUMED_OK の一行にしてください。以前の INITIAL の依頼は続行しないでください。最後に result.md を読み直して内容を確認してください。",
    });
    await waitUntil(
      () => runs === 2 && activeWorkers === 0 && !tasks.tasks.get(id).executing,
      120_000,
    );
    const task = tasks.tasks.get(id);
    assert.equal(task.state, "completed");
    assert.equal(task.codexThreadId, firstThreadId);
    assert.equal(maximumActiveWorkers, 1);
    assert.equal(
      (await readFile(join(task.workingDirectory, "result.md"), "utf8")).trim(),
      "RESUMED_OK",
    );
    assert.equal(
      (await exec("git", ["-C", repository, "status", "--porcelain"])).stdout,
      "",
    );
    report.sameCodexSession = true;
    report.maximumActiveWorkers = maximumActiveWorkers;
  });
  await check("lateNotificationKeepsCompletedState", async () => {
    releaseProgress();
    releaseNotice();
    await waitUntil(() => tasks.notifications.size === 0, 1_000);
    assert.equal(cards.at(-1), "completed");
    assert.equal(tasks.list()[0].state, "completed");
  });
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.failedCheck = checking;
  report.errorCode = voiceErrorCode(error);
  process.exitCode = 1;
} finally {
  releaseProgress();
  releaseNotice();
  await tasks?.stop();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
  console.log(JSON.stringify(report, null, 2));
}
