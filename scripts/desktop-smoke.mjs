import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { _electron as electron, chromium } from "playwright";
import { Client } from "../packages/client/dist/index.js";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
const directory = await mkdtemp(join(tmpdir(), "ido-desktop-smoke-"));
if (!resolve(directory).startsWith(resolve(tmpdir()) + sep))
  throw new Error("INVALID_TEMP_PATH");
const require = createRequire(import.meta.url);
let app;
let browser;
let browserClient;
try {
  const task = {
    id: "synthetic-task",
    requestId: "synthetic-request",
    meetingId: "meeting",
    projectId: "project",
    authorId: "user",
    title: "フォーラム同期を確認",
    text: "合成テストの実行結果",
    state: "completed",
    runId: "synthetic-run",
    revision: 1,
    network: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [],
  };
  await writeFile(
    join(directory, "runs.json"),
    JSON.stringify({
      runs: {
        "synthetic-run": {
          task,
          directory: join(directory, "workspace"),
          state: "completed",
          result: "テスト用の結果です。",
        },
      },
      commands: [],
    }),
  );
  const packaged = process.argv[2];
  const env = { ...process.env, IDO_DATA_DIR: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: packaged ? resolve(packaged) : require("electron"),
    args: packaged ? [] : [resolve(".ido-build/desktop/app")],
    env,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByLabel("EngineのURL").waitFor();
  await page.getByText("この端末の本人情報", { exact: true }).waitFor();
  const originalSettings = JSON.parse(
    await readFile(join(directory, "client.json"), "utf8"),
  );
  assert.equal(
    await page.evaluate(() => typeof globalThis.require),
    "undefined",
  );
  assert.equal(
    await page.evaluate(() => typeof globalThis.idoDesktop?.pickDirectory),
    "function",
  );
  assert.match(await page.locator("body").innerText(), /PID \d+/);
  await app.evaluate(({ app }) =>
    app.emit(
      "open-url",
      { preventDefault() {} },
      "ido-agent://connect?engine=https%3A%2F%2Fengine.example.com",
    ),
  );
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector(
        'input[placeholder="https://engine.example.com"]',
      )?.value === "https://engine.example.com",
  );
  const state = await page.evaluate(async () =>
    (await fetch("/api/state")).json(),
  );
  assert.equal(state.connected, false);
  assert.equal(state.allow, false);
  assert.equal(state.pairing, null);
  const appPath = await app.evaluate(({ app }) => app.getAppPath());
  const packagedRequire = createRequire(join(appPath, "main.js"));
  const cpu = process.arch === "arm64" ? "aarch64" : "x86_64";
  const target =
    process.platform === "win32"
      ? "pc-windows-msvc"
      : process.platform === "darwin"
        ? "apple-darwin"
        : "unknown-linux-musl";
  const binary = join(
    dirname(
      packagedRequire.resolve(
        `@openai/codex-${process.platform}-${process.arch}/package.json`,
      ),
    ),
    "vendor",
    `${cpu}-${target}`,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
  const native = await new Promise((resolve, reject) =>
    execFile(binary, ["--version"], { windowsHide: true }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim()),
    ),
  );
  assert.match(native, /codex/i);
  const claudeRoot = dirname(
    packagedRequire.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    ),
  );
  const claudeVersion = await new Promise((resolve, reject) =>
    execFile(
      join(claudeRoot, process.platform === "win32" ? "claude.exe" : "claude"),
      ["--version"],
      { windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
  assert.match(claudeVersion, /Claude/i);
  // Current Client navigation shows tasks in project groups. This fixture is
  // deliberately offline, so saved remote tasks remain visible but disabled.
  const savedTask = page
    .locator(".task-link")
    .filter({ hasText: "フォーラム同期を確認" });
  await savedTask.waitFor();
  assert.ok(await savedTask.isDisabled());
  assert.equal(
    state.runs.find((run) => run.task.id === task.id)?.result,
    "テスト用の結果です。",
  );
  assert.equal(
    await page
      .getByRole("button", { name: "タスクを停止", exact: true })
      .count(),
    0,
  );
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await page.screenshot({
    path: ".ido-build/screenshots/desktop-tasks.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  const runtime = JSON.parse(
    await readFile(join(directory, "runtime.json"), "utf8"),
  );
  const exited = app.waitForEvent("close");
  await app.evaluate(({ app }) => {
    app.quit();
  });
  await exited;
  app = undefined;
  await assert.rejects(access(join(directory, "runtime.lock")));
  await assert.rejects(
    fetch(`http://127.0.0.1:${runtime.port}/status`, {
      method: "POST",
      signal: AbortSignal.timeout(1000),
    }),
  );
  // Reopen the same installed data through the browser entry point, then the
  // desktop entry point. Ports and renderer storage are deliberately different.
  browserClient = new Client(directory);
  browserClient.checkAccount = async () => {};
  await browserClient.start(0);
  assert.equal(browserClient.settings.publicKey, originalSettings.publicKey);
  assert.equal(browserClient.identityStatus, "restored");
  browser = await chromium.launch({ headless: true });
  const browserPage = await browser.newPage();
  await browserPage.goto(browserClient.origin);
  await browserPage
    .getByText("保存済みの本人情報を復元しました。", { exact: true })
    .waitFor();
  await browserPage.reload();
  await browserPage
    .getByText("保存済みの本人情報を復元しました。", { exact: true })
    .waitFor();
  await browser.close();
  browser = undefined;
  await browserClient.close();
  browserClient = undefined;
  app = await electron.launch({
    executablePath: packaged ? resolve(packaged) : require("electron"),
    args: packaged ? [] : [resolve(".ido-build/desktop/app")],
    env,
  });
  const reopened = await app.firstWindow();
  await reopened
    .getByText("保存済みの本人情報を復元しました。", { exact: true })
    .waitFor();
  const restoredSettings = JSON.parse(
    await readFile(join(directory, "client.json"), "utf8"),
  );
  assert.equal(restoredSettings.publicKey, originalSettings.publicKey);
  assert.deepEqual(restoredSettings.profile, originalSettings.profile);
  await reopened.screenshot({
    path: ".ido-build/screenshots/desktop-identity-restored.png",
    fullPage: true,
  });
  const reopenedExit = app.waitForEvent("close");
  await app.evaluate(({ app }) => app.quit());
  await reopenedExit;
  app = undefined;
  console.log(
    "Desktop smoke passed: native window, isolated renderer, task list, bundled Codex, clean shutdown, identity preserved across browser and desktop restarts.",
  );
} finally {
  await browser?.close();
  await browserClient?.close();
  await app?.close();

  await rm(directory, { recursive: true, force: true });
}
