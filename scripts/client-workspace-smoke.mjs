// Real Client routes and executor, synthetic Codex responses; no account login,
// remote Engine, Discord message, or model request is made by this smoke test.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { Client } from "../packages/client/dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "ido-workspace-ui-"));
const client = new Client(join(directory, "client"));
let catalogAgents = [
  {
    agent: "codex",
    authenticated: true,
    models: [{ id: "test-codex-model", name: "Test Codex" }],
  },
  {
    agent: "claude",
    authenticated: true,
    models: [{ id: "opus", name: "Test Claude" }],
  },
];
client.agentCatalog = async () => catalogAgents;
client.credentials.backend = "file";
let browser, running, release;
const steers = [];
let turn = 0;
try {
  const repository = join(directory, "repo");
  await mkdir(repository);
  const git = (...args) =>
    execFileSync("git", ["-C", repository, ...args], {
      windowsHide: true,
      stdio: "pipe",
    });
  git("init");
  await writeFile(join(repository, "forum.ts"), "export const sync = false;\n");
  git("add", "forum.ts");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "Fixture",
  );
  await writeFile(join(repository, "forum.ts"), "export const sync = true;\n");
  await client.start(0);
  client.settings.projects = [
    { id: "project", name: "discord-voice", remote: "" },
    { id: "tools", name: "team-tools", remote: "" },
  ];
  client.settings.mappings = [
    { projectId: "project", directory: repository, network: false, slots: 1 },
  ];
  client.connected = true;
  client.controlSupported = true;
  client.settings.deviceId = "local-device";
  client.teamTasksSupported = true;
  client.teamTasks = {
    updatedAt: Date.now(),
    total: 2,
    tasks: [
      {
        id: "remote-task",
        runId: "remote-run",
        revision: 1,
        projectId: "project",
        title: "共有ルーティングを確認",
        state: "running",
        clientId: "other-device",
        ownerName: "Demo teammate",
        deviceName: "Demo Mac",
        deviceConnected: true,
        progress: "ルーティングのテストを実行中です。",
        updatedAt: Date.now(),
      },
      {
        id: "queued-task",
        runId: "queued-run",
        revision: 1,
        projectId: "project",
        title: "未割り当ての依頼",
        state: "queued",
        updatedAt: Date.now(),
      },
    ],
  };
  client.allow = true;
  const thread = {
    activeTurnId: null,
    async steer(text) {
      steers.push(text);
      return true;
    },
    async runStreamed(prompt, options) {
      return {
        events: (async function* () {
          const n = ++turn;
          thread.activeTurnId = `turn-${n}`;
          yield { type: "thread.started", thread_id: "fixture-thread" };
          yield { type: "turn.started" };
          yield {
            type: "item.completed",
            item: {
              type: "agent_message",
              id: `note-${n}`,
              phase: "commentary",
              text:
                options.collaborationMode === "plan"
                  ? "既存のタスクとフォーラムの対応を確認します。\n状態の更新と追加指示の配送を、同じスレッドにまとめる方針です。"
                  : "合意した計画に沿って進めています。\n**権限の設定は維持**し、フォーラムとの同期部分を確認します。",
            },
          };
          yield {
            type: "item.completed",
            item: {
              type: "command_execution",
              id: `command-${n}`,
              command: "npm run test -- forum",
              aggregated_output:
                "Fixture output: 12 tests passed\nNo duplicate threads",
              exit_code: 0,
              status: "completed",
            },
          };
          if (options.collaborationMode === "default") {
            yield {
              type: "item.completed",
              item: {
                type: "file_change",
                id: "files",
                status: "completed",
                changes: [{ path: "forum.ts", kind: "update" }],
              },
            };
            await new Promise((resolve) => {
              release = resolve;
            });
          }
          yield {
            type: "item.completed",
            item: {
              type: "agent_message",
              id: `answer-${n}`,
              phase:
                options.collaborationMode === "plan" ? "plan" : "final_answer",
              text:
                options.collaborationMode === "plan"
                  ? "次の手順で進めます。\n\n- タスクごとのスレッド対応を保持する\n- 状態の更新と追加指示を同期する\n- 再起動後の重複作成をテストする\n\n確認したいことがあれば、そのまま会話を続けてください。"
                  : "表示確認用の実行結果です。",
            },
          };
          thread.activeTurnId = null;
          yield { type: "turn.completed" };
        })(),
      };
    },
  };
  client.executor.createCodex = () => ({
    startThread: () => thread,
    close: async () => {
      release?.();
    },
  });
  const task = {
    id: "task",
    runId: "run",
    revision: 1,
    specRevision: 1,
    state: "assigned",
    projectId: "project",
    meetingId: "meeting",
    authorId: "member",
    requestId: "request",
    title: "Discordフォーラムの同期を整える",
    text: "フォーラムのスレッドとタスクを同期したい。\nまず方針を相談してから実装を進めよう。",
    network: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [],
  };
  const value = {
    task,
    directory: repository,
    state: "assigned",
    progressMode: "manual",
  };
  client.executor.runs.run = value;
  for (const [id, title, projectId] of [
    ["install", "アプリのインストール案内を更新", "project"],
    ["mac", "Macの接続手順を確認", "project"],
    ["notes", "議事録の整理方法を検討", "tools"],
  ])
    client.executor.runs[id] = {
      task: { ...task, id, runId: id, title, projectId },
      directory: repository,
      state: "completed",
      result: "表示確認用の過去タスクです。",
    };
  running = client.executor
    .execute(value, client.settings.mappings[0], false)
    .catch(() => {});
  client.executor.running.set("run", running);
  client.control = async (runId, requestKey, instruction) => {
    await client.executor.receive(
      {
        v: 1,
        type: "steer",
        id: requestKey,
        taskId: "task",
        runId,
        revision: 1,
        text: instruction,
      },
      client.settings.mappings,
      true,
      1,
    );
    return { accepted: true };
  };
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1360, height: 980 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(client.origin);
  await page.getByRole("button", { name: "実行する", exact: true }).waitFor();
  await page
    .getByRole("region", { name: "ほかのPC", exact: true })
    .getByRole("button")
    .click();
  await page
    .getByText("ルーティングのテストを実行中です。", { exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("エージェントへの追加指示").count(), 0);
  assert.equal(
    await page
      .getByRole("button", { name: "タスクを停止", exact: true })
      .count(),
    0,
  );
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-team-tasks.png",
  });
  await page
    .getByRole("region", { name: "未割り当て", exact: true })
    .getByRole("button")
    .click();
  await page
    .getByText("実行先が決まると、このPCまたはほかのPCの一覧へ移動します。", {
      exact: true,
    })
    .waitFor();
  client.connected = false;
  await page.getByRole("button", { name: "最新の状態に更新" }).click();
  await page
    .getByText("ほかのPCの状態を見るには接続してください。", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("region", { name: "ほかのPC", exact: true })
      .getByRole("button")
      .count(),
    0,
  );
  client.connected = true;
  await page.getByRole("button", { name: "最新の状態に更新" }).click();
  await page
    .locator(".task-link")
    .filter({ hasText: "Discordフォーラムの同期を整える" })
    .click();
  await page.getByRole("button", { name: "実行する", exact: true }).waitFor();
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-manual.png",
  });
  await page
    .getByLabel("エージェントへの追加指示")
    .fill("再起動時の重複も確認してください");
  await page
    .getByRole("button", { name: "追加指示を送信", exact: true })
    .click();
  await page
    .getByText("再起動時の重複も確認してください", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "実行する", exact: true }).waitFor();
  await page.getByRole("button", { name: "実行する", exact: true }).click();
  await page
    .getByText("1 件のファイルを変更", { exact: true })
    .first()
    .waitFor();
  await page
    .getByLabel("エージェントへの追加指示")
    .fill("公開せず、ローカルの検証までお願いします");
  await page
    .getByRole("button", { name: "追加指示を送信", exact: true })
    .click();
  await page
    .getByText("公開せず、ローカルの検証までお願いします", { exact: true })
    .waitFor();
  assert.deepEqual(steers, ["公開せず、ローカルの検証までお願いします"]);
  await page
    .locator(".tool-entry")
    .filter({ hasText: "コマンドを実行" })
    .last()
    .locator("summary")
    .click();
  await page
    .getByText(/Fixture output: 12 tests passed/)
    .last()
    .waitFor({ state: "visible" });
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-running.png",
  });
  await page
    .getByRole("button", { name: "変更を確認", exact: true })
    .first()
    .click();
  await page.getByRole("dialog").waitFor();
  await page.getByText(/export const sync = true/).waitFor();
  assert.match(await page.locator(".diff-preview").innerText(), /sync = true/);
  await page.keyboard.press("Escape");
  await page.getByLabel("タスクを検索").fill("Mac");
  await page
    .locator(".task-link")
    .filter({ hasText: "Macの接続手順を確認" })
    .click();
  await page
    .getByText("表示確認用の過去タスクです。", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "タスクを停止", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByLabel("タスクを検索").fill("");
  await page
    .locator(".task-link")
    .filter({ hasText: "Discordフォーラムの同期を整える" })
    .click();
  await page.getByRole("button", { name: "タスクを停止", exact: true }).click();
  await page.getByText("停止済み", { exact: true }).waitFor();
  client.connected = false;
  client.allow = false;
  const localFrames = [];
  client.emit = (frame) => localFrames.push(frame);
  await page
    .getByRole("button", { name: "新しいローカルタスク", exact: true })
    .click();
  await page.getByLabel("タイトル", { exact: true }).fill("ローカルの実験");
  await page
    .getByRole("option", { name: "Test Codex" })
    .waitFor({ state: "attached" });
  await page
    .getByLabel("使用するモデル", { exact: true })
    .selectOption("test-codex-model");
  await page
    .getByLabel("Gitリポジトリのフォルダー", { exact: true })
    .fill(repository);
  await page
    .getByLabel("依頼内容", { exact: true })
    .fill("このPCで実験の方針を相談してから試してください");
  await page.getByLabel("進め方", { exact: true }).selectOption("manual");
  await page.getByRole("button", { name: "相談を開始", exact: true }).click();
  await page.getByRole("button", { name: "実行する", exact: true }).waitFor();
  await page.getByText("このアプリからの依頼", { exact: true }).waitFor();
  await page
    .locator(".model-label")
    .filter({ hasText: "test-codex-model" })
    .waitFor();
  await page
    .getByLabel("エージェントへの追加指示")
    .fill("実験の前提も整理してください");
  await page
    .getByRole("button", { name: "追加指示を送信", exact: true })
    .click();
  await page
    .getByText("実験の前提も整理してください", { exact: true })
    .waitFor();
  await page.getByRole("button", { name: "実行する", exact: true }).waitFor();
  await page.getByRole("button", { name: "実行する", exact: true }).click();
  await page
    .getByText("1 件のファイルを変更", { exact: true })
    .first()
    .waitFor();
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-local-experiment.png",
  });
  await page.getByRole("button", { name: "タスクを停止", exact: true }).click();
  await page.getByText("停止済み", { exact: true }).waitFor();
  assert.deepEqual(localFrames, []);
  // Provider selection uses the same app lifecycle without contacting Claude.
  client.executor.createClaude = client.executor.createCodex;
  await page
    .getByRole("button", { name: "新しいローカルタスク", exact: true })
    .click();
  await page.getByLabel("エージェント", { exact: true }).selectOption("claude");
  await page.getByLabel("使用するモデル", { exact: true }).selectOption("opus");
  await page.getByLabel("エージェント", { exact: true }).selectOption("codex");
  await page
    .getByLabel("使用するモデル", { exact: true })
    .selectOption("test-codex-model");
  await page.getByLabel("エージェント", { exact: true }).selectOption("claude");
  assert.equal(
    await page.getByLabel("使用するモデル", { exact: true }).inputValue(),
    "opus",
  );
  await page.getByLabel("タイトル", { exact: true }).fill("Claudeで実験");
  await page
    .getByLabel("Gitリポジトリのフォルダー", { exact: true })
    .fill(repository);
  await page
    .getByLabel("依頼内容", { exact: true })
    .fill("Claudeで方針を相談してください");
  await page.getByLabel("進め方", { exact: true }).selectOption("manual");
  await page
    .getByRole("checkbox", { name: /Claudeのツールは操作ごとに承認/ })
    .check();
  await page.getByRole("button", { name: "相談を開始", exact: true }).click();
  await page.getByRole("button", { name: "実行する", exact: true }).waitFor();
  await page
    .locator(".model-label")
    .filter({ hasText: "Claude Code" })
    .waitFor();
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-claude.png",
  });
  assert.equal(
    Object.values(client.executor.runs).find(
      (run) => run.task.title === "Claudeで実験",
    )?.agent,
    "claude",
  );
  await page.getByRole("button", { name: "タスクを停止", exact: true }).click();
  await page.getByText("停止済み", { exact: true }).waitFor();
  assert.deepEqual(localFrames, []);
  await page.setViewportSize({ width: 430, height: 850 });
  await page
    .getByRole("button", { name: "サイドバーを閉じる", exact: true })
    .click();
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-mobile.png",
  });
  assert.ok(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  await page.setViewportSize({ width: 1360, height: 980 });
  await page
    .getByRole("button", { name: "サイドバーの表示を切り替える", exact: true })
    .click();
  await page
    .getByRole("button", { name: "新しいローカルタスク", exact: true })
    .click();
  catalogAgents = [
    {
      agent: "claude",
      authenticated: true,
      models: [{ id: "opus", name: "Test Claude" }],
    },
  ];
  await page
    .getByRole("button", { name: "ログイン状況・モデル一覧を更新" })
    .click();
  await page
    .getByRole("option", { name: "Test Claude", exact: true })
    .waitFor({ state: "attached" });
  assert.equal(
    await page.getByRole("option", { name: "Codex", exact: true }).count(),
    0,
  );
  catalogAgents = [];
  await page
    .getByRole("button", { name: "ログイン状況・モデル一覧を更新" })
    .click();
  await page.getByText(/ログイン済みのエージェントがありません/).waitFor();
  assert.equal(
    await page.getByLabel("エージェント", { exact: true }).count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "ローカルで開始", exact: true })
      .isDisabled(),
    true,
  );
  console.log(
    "Workspace smoke passed: Manual discussion -> execute, live instruction, command output, diff, search, stop and narrow layout.",
  );
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    await page
      .screenshot({ path: ".ido-build/screenshots/workspace-failure.png" })
      .catch(() => {});
    console.error(
      await page
        .locator("main")
        .innerText()
        .catch(() => ""),
    );
  }
  throw error;
} finally {
  await browser?.close();
  await client.close();
  await running;
  await rm(directory, { recursive: true, force: true });
}
