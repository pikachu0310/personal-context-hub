import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexVoiceRunner } from "../src/discord-voice-openai.mjs";
import {
  DiscordVoiceTaskQueue,
  authorizeMeetingTasks,
} from "../src/discord-voice-session.mjs";

// Real Codex integration test: only synthetic data in a new temporary repository.
// Intentionally retain the workspaces and report so a person can inspect the evidence.
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "idobata-live-smoke-"));
const repository = join(root, "fixture");
await mkdir(repository);
const git = (...args) => exec("git", ["-C", repository, ...args]);
await git("init");
await writeFile(
  join(repository, "math.mjs"),
  "export const add = (a, b) => a - b;\n",
);
await writeFile(
  join(repository, "math.test.mjs"),
  'import assert from "node:assert/strict";\nimport test from "node:test";\nimport { add } from "./math.mjs";\ntest("adds positive and negative numbers", () => { assert.equal(add(2, 3), 5); assert.equal(add(-2, 3), 1); });\n',
);
await git("add", "math.mjs", "math.test.mjs");
await git(
  "-c",
  "user.name=Idobata Test",
  "-c",
  "user.email=test@example.invalid",
  "commit",
  "-m",
  "synthetic fixture",
);
const runnerConfig = {
  workingDirectory: repository,
  statePath: join(root, "observer.json"),
  isolatedCodexHome: join(root, "codex-home"),
  codexHome: process.env.PERSONAL_CONTEXT_VOICE_CODEX_HOME,
  taskWorkspaceDirectory: join(root, "workspaces"),
  powerMode: true,
  voiceMode: "meeting",
  taskModel: process.env.PERSONAL_CONTEXT_VOICE_TASK_MODEL ?? "gpt-5.6-sol",
  taskReasoningEffort: "medium",
  observerModel: "gpt-5.6-sol",
  observerReasoningEffort: "low",
  allowedUserId: "operator",
};
const runner = new CodexVoiceRunner(runnerConfig);
await runner.prepare();
const statements = [
  {
    sequence: 1,
    userId: "participant",
    speakerName: "参加者",
    text: "外部への公開はしない。計算のテストを残したい。",
  },
  {
    sequence: 2,
    userId: "operator",
    speakerName: "担当者",
    text: "井戸Bot、math.mjsの加算バグを修正し、node --testで検証してください。",
  },
];
const observation = JSON.parse(
  await runner.observeMeeting(
    {
      minutes: "前提: ローカル検証用repo",
      transcript: statements.map((item) => item.text).join("\n"),
      statements,
    },
    { signal: AbortSignal.timeout(60_000) },
  ),
);
const authorized = authorizeMeetingTasks(
  observation.tasks,
  statements,
  "operator",
);
assert.equal(
  authorized.length,
  1,
  "real observer must route the explicit operator request",
);
assert.deepEqual(authorized[0].sourceSequences, [2]);
const reports = [];
const queue = new DiscordVoiceTaskQueue({
  concurrency: 2,
  taskTimeoutMs: 240_000,
  logger: {},
  postText: async () => undefined,
  createTaskThread: async (task) => ({
    threadId: task.id,
    post: async () => undefined,
    update: async () => undefined,
  }),
  runTask: (task, options) => runner.runTask(task, options),
  onResult: async (result) => reports.push(result),
});
queue.enqueue({
  title: "加算バグを実装・テスト",
  kind: "implementation",
  request:
    "math.mjsのaddが減算になっています。加算へ修正し、node --test math.test.mjsを実行して実際の結果を報告してください。外部通信やcommitは不要です。",
  context: "合意: 2+3=5、-2+3=1。既存テストを変更して通すのは禁止。",
});
queue.enqueue({
  title: "配列検索とSet検索を計測",
  kind: "benchmark",
  request:
    "10000個の整数に対するArray.includesとSet.hasを比較するbench.mjsを作って実行してください。各10000回検索、同一入力、3回計測の中央値msをbench-result.jsonにarrayMs,setMsとして保存してください。Set構築は検索計測から除外し、その条件を報告してください。外部通信やcommitは不要です。",
  context: "両方式が同じヒット件数であることもコード内でassertしてください。",
});
const deadline = Date.now() + 250_000;
while (
  Date.now() < deadline &&
  queue.list().some((task) => ["queued", "running"].includes(task.state))
) {
  await new Promise((resolve) => setTimeout(resolve, 200));
}
const snapshot = queue.snapshot();
await queue.stop();
assert.equal(snapshot.length, 2);
assert.ok(
  snapshot.every((task) => task.state === "completed"),
  JSON.stringify(snapshot.map(({ title, state }) => ({ title, state }))),
);
const implementation = snapshot.find((task) => task.kind === "implementation");
const benchmark = snapshot.find((task) => task.kind === "benchmark");
const verification = await exec(process.execPath, ["--test", "math.test.mjs"], {
  cwd: implementation.workingDirectory,
});
const numbers = JSON.parse(
  await readFile(join(benchmark.workingDirectory, "bench-result.json"), "utf8"),
);
assert.ok(Number.isFinite(numbers.arrayMs) && numbers.arrayMs >= 0);
assert.ok(Number.isFinite(numbers.setMs) && numbers.setMs >= 0);
assert.equal(
  await readFile(join(repository, "math.mjs"), "utf8"),
  "export const add = (a, b) => a - b;\n",
);
const resumedRunner = new CodexVoiceRunner(runnerConfig);
const continuation = {
  ...implementation,
  additionalInstruction:
    "負数同士の加算（-2と-3が-5）をmath.test.mjsへ追加し、node --test math.test.mjsで確認してください。既存のテストを残してください。",
};
await resumedRunner.runTask(continuation, {
  signal: AbortSignal.timeout(120_000),
});
assert.equal(continuation.codexThreadId, implementation.codexThreadId);
const resumedVerification = await exec(
  process.execPath,
  ["--test", "math.test.mjs"],
  { cwd: continuation.workingDirectory },
);
await resumedRunner.applyTask(continuation);
await exec(process.execPath, ["--test", "math.test.mjs"], { cwd: repository });
const report = {
  realCodex: true,
  discordConnected: false,
  sourceUnchangedBeforeExplicitApply: true,
  explicitApply: "passed",
  observerRouting: "passed",
  sameThreadResume: "passed",
  resumedTestOutput: resumedVerification.stdout,
  tasks: snapshot,
  benchmark: numbers,
  independentTestOutput: verification.stdout,
  resultFeedbackCount: reports.length,
};
const reportPath = join(root, "report.json");
await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(
  JSON.stringify(
    {
      realCodex: true,
      discordConnected: false,
      sourceUnchangedBeforeExplicitApply: true,
      observerRouting: "passed",
      sameThreadResume: "passed",
      explicitApply: "passed",
      independentTests: "passed",
      benchmark: numbers,
      reportPath,
    },
    null,
    2,
  ),
);
