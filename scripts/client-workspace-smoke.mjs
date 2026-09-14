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
const catalogAgents = [
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
  client.allowedProjects.add("project");
  client.settings.deviceId = "local-device";
  client.settings.identityId = "client:" + "a".repeat(64);
  client.teamTasksSupported = true;
  client.teamTasks = {
    updatedAt: Date.now(),
    total: 3,
    tasks: [
      {
        id: "historical-self",
        runId: "historical-run",
        revision: 1,
        projectId: "project",
        title: "以前の自分のタスク",
        state: "completed",
        clientId: "old-device",
        clientIdentityId: client.settings.identityId,
        participants: [
          {
            id: "old-device",
            identityId: client.settings.identityId,
            name: "Old profile",
          },
          {
            id: "local-device",
            identityId: client.settings.identityId,
            name: "Current profile",
          },
        ],
        ownerName: "Old profile",
        updatedAt: Date.now(),
      },
      {
        id: "remote-task",
        runId: "remote-run",
        revision: 1,
        projectId: "project",
        title: "共有ルーティングを確認",
        state: "running",
        clientId: "other-device",
        participants: [
          { id: "other-device", name: "Demo teammate" },
          { id: "member-two", name: "Alex" },
          { id: "member-three", name: "Sam" },
          { id: "member-four", name: "Taylor" },
          { id: "idobot", name: "idobot", bot: true },
        ],
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
    createdByBot: true,
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
  assert.equal(await page.locator(".avatar-overflow").innerText(), "+2");
  assert.ok((await page.locator(".task-avatars .bot-avatar").count()) > 0);
  const historical = page.getByRole("region", {
    name: "自分の以前の登録",
    exact: true,
  });
  assert.equal(await historical.locator(".user-avatar").count(), 1);
  assert.equal(
    await historical.locator(".task-avatars").getAttribute("aria-label"),
    "参加者: 参加者",
  );
  await historical.getByRole("button").click();
  await page
    .getByRole("heading", { name: "以前の自分のタスク", level: 2, exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "タスクを停止", exact: true })
      .count(),
    0,
  );
  assert.equal(client.teamTasks.tasks[0].clientId, "old-device");
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
  for (let attempt = 0; !steers.length && attempt < 100; attempt++)
    await new Promise((resolve) => setTimeout(resolve, 20));
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
      .count(),
    0,
  );
  assert.ok(await page.getByLabel("エージェントへの追加指示").isEnabled());
  assert.ok(
    await page
      .getByRole("button", { name: "追加指示を送信", exact: true })
      .isDisabled(),
  );
  await page.getByLabel("タスクを検索").fill("");
  await page
    .locator(".task-link")
    .filter({ hasText: "Discordフォーラムの同期を整える" })
    .click();
  await page.getByRole("button", { name: "タスクを停止", exact: true }).click();
  await page.getByText("停止済み", { exact: true }).waitFor();
  // The project workspace replaces the old global local-task/run navigation.
  assert.equal(
    await page
      .getByRole("button", { name: "新しいローカルタスク", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole("button", { name: "実行と承認", exact: true }).count(),
    0,
  );
  client.settings.profile = { name: "Demo user", context: "" };
  await page.getByRole("button", { name: "最新の状態に更新" }).click();
  await page.getByRole("button", { name: "ユーザー設定を開く" }).click();
  const avatarFile = await page.locator(".brand-symbol").screenshot();
  await page.locator('input[type="file"]').setInputFiles({
    name: "avatar.png",
    mimeType: "image/png",
    buffer: avatarFile,
  });
  await page.locator(".profile-avatar-editor img").waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.locator(".local-avatar img").waitFor();
  assert.match(client.settings.profile.avatar, /^data:image\/jpeg;base64,/);
  await page.reload();
  await page.locator(".local-avatar img").waitFor();
  await page.locator(".task-avatars img").first().waitFor();
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-avatars.png",
  });
  await page.getByRole("button", { name: "ユーザー設定を開く" }).click();
  await page.getByRole("button", { name: "アイコンを削除" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.equal(client.settings.profile.avatar, undefined);

  client.connected = false;
  await page.getByRole("button", { name: "最新の状態に更新" }).click();
  await page.locator(".connection-required").waitFor();
  for (const row of await page.locator(".task-link").all())
    assert.ok(await row.isDisabled());
  for (const button of await page.locator(".project-compose").all())
    assert.ok(await button.isDisabled());
  assert.equal(await page.getByLabel("エージェントへの追加指示").count(), 0);
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-disconnected.png",
  });
  let reconnects = 0;
  client.settings.engineUrl = "https://engine.example.invalid";
  client.connect = async () => {
    reconnects++;
    client.connected = true;
    client.status = "connected";
  };
  await page.getByRole("button", { name: "再接続", exact: true }).click();
  await page.locator(".connection-required").waitFor({ state: "hidden" });
  assert.equal(reconnects, 1);
  for (const row of await page.locator(".task-link").all())
    assert.ok(await row.isEnabled());
  client.projectCreationSupported = true;
  await page.getByRole("button", { name: "最新の状態に更新" }).click();
  await page
    .getByRole("button", { name: "プロジェクトを追加", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor();
  await page.waitForTimeout(250);
  const box = await dialog.boundingBox();
  assert.ok(
    Math.abs(box.y + box.height / 2 - 490) < 25,
    "Project modal must be vertically centered",
  );
  await page.screenshot({
    path: ".ido-build/screenshots/workspace-project-modal.png",
  });
  await page.keyboard.press("Escape");
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
  console.log(
    "Workspace smoke passed: Manual discussion -> execute, live instruction, command output, diff, search, stop, offline gating, reconnect, avatar upload/removal, centered modal and narrow layout.",
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
