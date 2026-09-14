import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexVoiceRunner } from "../src/execution/codex/runner.mjs";
import { loadDiscordVoiceConfig } from "../src/runtime/discord-voice/config.mjs";
import { parseMeetingObservation } from "../src/engine/observation/observation.mjs";
import {
  hasTaskCommitment,
  shouldDeliverObservationReply,
} from "../src/engine/observation/participation.mjs";

// Real observer, fictional conversations, no task execution or Discord writes.
const config = loadDiscordVoiceConfig();
const root = await mkdtemp(join(tmpdir(), "idobata-restraint-smoke-"));
const runner = new CodexVoiceRunner({
  ...config,
  isolatedCodexHome: join(root, "codex-home"),
  statePath: join(root, "observer.json"),
  allowedUserId: "operator",
  allParticipantsOperate: true,
  autonomousTasks: true,
  powerMode: true,
  observerModel: "gpt-5.6-sol",
  observerReasoningEffort: "low",
});
const scenarios = [
  {
    id: "human-question",
    text: ["佐藤さん、このボタンはどこに置くの？", "右上に置く予定です。"],
    tasks: 0,
    reply: false,
  },
  {
    id: "tentative-work",
    text: [
      "入力検証を追加したほうがいいかも。",
      "まだ実装するかは決めていない。",
    ],
    tasks: 0,
    reply: false,
  },
  {
    id: "problem-only",
    text: ["ログが多くて必要な情報を見つけにくい。"],
    tasks: 0,
    reply: false,
  },
  {
    id: "withdrawn-request",
    text: [
      "井戸Bot、フォームの入力検証を実装して。",
      "やっぱり今は保留にしよう。まだ実装しなくていい。",
    ],
    tasks: 0,
    reply: false,
  },
  {
    id: "agreed-delegation",
    text: ["フォームの入力検証を追加する作業はBotに任せよう。"],
    tasks: 1,
    reply: false,
  },
  {
    id: "direct-request",
    text: ["井戸Bot、フォームに空文字を拒否する入力検証を追加して。"],
    tasks: 1,
    reply: false,
  },
  {
    id: "answered-question",
    text: [
      "井戸Bot、会議の開始は何時？",
      "開始は15時です。",
      "了解、解決しました。",
    ],
    tasks: 0,
    reply: false,
  },
  {
    id: "direct-answer",
    text: ["井戸Bot、前回決めたフォームの必須項目は何？"],
    minutes: "決定: 名前とメールアドレスを必須にする。",
    tasks: 0,
    reply: true,
  },
];
const report = {
  model: "gpt-5.6-sol",
  reasoning: "low",
  realObserver: true,
  discordWrites: false,
  taskExecution: false,
  scenarios: [],
};
try {
  await runner.prepare();
  for (const scenario of scenarios) {
    const statements = scenario.text.map((text, index) => ({
      text,
      userId: "operator",
      speakerName: "参加者",
      sequence: index + 1,
      taskEligible: true,
    }));
    const started = Date.now();
    const raw = await runner.observeMeeting(
      {
        statements,
        minutes: scenario.minutes ?? "",
        transcript: scenario.text.join("\n"),
        activeTasks: [],
        results: [],
      },
      { signal: AbortSignal.timeout(60000) },
    );
    const observation = parseMeetingObservation(raw);
    const tasks = observation.tasks.filter((task) =>
      hasTaskCommitment(task, statements, { autonomousTasks: true }),
    );
    const reply = shouldDeliverObservationReply(observation, statements);
    const row = {
      id: scenario.id,
      elapsedMs: Date.now() - started,
      rawTasks: observation.tasks.length,
      acceptedTasks: tasks.length,
      reply,
      passed: tasks.length === scenario.tasks && reply === scenario.reply,
    };
    report.scenarios.push(row);
    console.log(JSON.stringify(row));
  }
  assert.ok(
    report.scenarios.every((row) => row.passed),
    "Observer behavior differs from the fictional scenario expectations",
  );
  report.status = "passed";
} catch (error) {
  report.status = "failed";
  report.error = { name: error.name, code: error.code };
  process.exitCode = 1;
} finally {
  await runner.close();
  const reportPath = join(root, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ status: report.status, reportPath }));
}
