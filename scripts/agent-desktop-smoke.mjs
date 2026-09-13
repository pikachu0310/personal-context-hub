/* global window */
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
const directory = await mkdtemp(join(tmpdir(), "ido-desktop-smoke-"));
const db = new DatabaseSync(join(directory, "state_5.sqlite"));
db.exec(
  "CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, has_user_event INTEGER)",
);
db.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?, 0, 1)").run(
  "sample",
  "Sample local task",
  "sample/repository",
  Date.now() / 1000,
  Date.now() / 1000,
);
db.close();
let application;
try {
  application = await electron.launch({
    executablePath: resolve("dist/desktop/win-unpacked/IDO Agent.exe"),
    env: {
      ...process.env,
      LOCALAPPDATA: directory,
      APPDATA: directory,
      CODEX_HOME: directory,
    },
    timeout: 30000,
  });
  const page = await application.firstWindow();
  await page
    .getByRole("heading", { name: "ここがエージェントの作業場所です。" })
    .waitFor();
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(
    await page.evaluate(() => typeof window.idoDesktop.request),
    "function",
  );
  const port = new URL(page.url()).port;
  assert.equal(new URL(page.url()).hash, "");
  assert.equal((await fetch(`http://127.0.0.1:${port}/status`)).status, 403);
  await assert.rejects(
    page.evaluate(() => window.idoDesktop.request("/arbitrary", {})),
  );
  await page.getByRole("button", { name: "接続設定", exact: true }).click();
  await page
    .getByRole("button", { name: "OpenAIでログイン", exact: true })
    .waitFor();
  await page.screenshot({ path: resolve("dist/desktop/settings-smoke.png") });
  await page.locator("#local-tasks").check();
  await page.getByRole("button", { name: /Sample local task/ }).waitFor();
  await page.getByRole("button", { name: /Sample local task/ }).click();
  await page.getByText("外部で管理 · 状態未確認", { exact: true }).waitFor();
  assert.equal(await page.locator("#cancel-task").isDisabled(), true);
  await page.getByRole("button", { name: "接続設定", exact: true }).click();
  await page.locator("#local-tasks").uncheck();
  await page
    .getByRole("button", { name: /Sample local task/ })
    .waitFor({ state: "detached" });
  const prefs = await application.evaluate(({ BrowserWindow }) => {
    const prefs =
      BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences();
    return {
      nodeIntegration: prefs.nodeIntegration,
      contextIsolation: prefs.contextIsolation,
      sandbox: prefs.sandbox,
    };
  });
  assert.deepEqual(prefs, {
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  });
  // UI-only fixture after the real IPC checks above. No remote task executes.
  await application.evaluate(({ ipcMain }) => {
    const now = Date.now();
    const tasks = [
      {
        id: "demo-running",
        title: "接続エラー時の案内を改善する",
        state: "running",
        request:
          "接続先に到達できない場合の案内を見直し、再接続できることを確認してください。",
        logs: [
          { at: now - 40000, text: "接続処理と既存のテストを確認しました。" },
          {
            at: now - 12000,
            text: "エラーメッセージを更新しました。再接続のテストを実行しています。",
          },
        ],
      },
      {
        id: "demo-approval",
        title: "セットアップ手順を見直す",
        state: "awaiting_approval",
        request: "初めて参加する人向けに手順を確認してください。",
        logs: [],
      },
      {
        id: "demo-done",
        title: "タスク一覧の絞り込みを追加する",
        state: "completed",
        request: "進行中と終了済みのタスクを切り替えられるようにしてください。",
        result: "絞り込みを追加し、動作を確認しました。",
        logs: [],
      },
    ].map((task) => ({
      ...task,
      source: "discord",
      workingDirectory: "C:/Projects/sample-app",
      startedAt: now - 90000,
    }));
    ipcMain.removeHandler("ido:request");
    ipcMain.handle("ido:request", (_event, path, input) => {
      if (path === "/stop-task") {
        const task = tasks.find((task) => task.id === input.id);
        if (!task) throw new Error("Unknown fixture task");
        task.state = "cancelled";
        return {};
      }
      if (path !== "/status") throw new Error("Not a fixture route");
      return {
        tasks,
        approvals: [],
        profile: {},
        connected: true,
        login: { authenticated: true },
        localTasks: { enabled: false },
      };
    });
  });
  await page
    .getByRole("button", { name: /接続エラー時の案内を改善する/ })
    .waitFor();
  await page
    .getByRole("button", { name: /接続エラー時の案内を改善する/ })
    .click();
  await page.screenshot({ path: resolve("dist/desktop/tasks-preview.png") });
  await page.getByRole("button", { name: "終了", exact: true }).click();
  assert.equal(await page.locator(".task-row").count(), 1);
  assert.equal(await page.locator("#cancel-task").isDisabled(), true);
  await page.getByRole("button", { name: "進行中", exact: true }).click();
  assert.equal(await page.locator(".task-row").count(), 2);
  await page
    .getByRole("button", { name: /接続エラー時の案内を改善する/ })
    .click();
  await page.getByRole("button", { name: "タスクを停止", exact: true }).click();
  await page
    .getByRole("button", { name: /接続エラー時の案内を改善する/ })
    .waitFor({ state: "detached" });
  assert.equal(await page.locator(".task-row").count(), 1);
  const closing = application.waitForEvent("close");
  await page.getByRole("button", { name: "アプリを終了", exact: true }).click();
  await closing;
  await assert.rejects(fetch(`http://127.0.0.1:${port}/status`));
  console.log(
    "PASS: packaged app window, isolated renderer, bounded IPC, protected status, and exit closes local service",
  );
} finally {
  await application?.close().catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
