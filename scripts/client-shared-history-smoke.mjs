// Two real Clients and Engine, synthetic model output. No account or model API is used.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Engine } from "../packages/engine/dist/index.js";
import { Client } from "../packages/client/dist/index.js";
const directory = await mkdtemp(join(tmpdir(), "ido-shared-ui-"));
const engine = new Engine({
  directory: join(directory, "engine"),
  port: 0,
  previewPort: 0,
});
engine.credentials.backend = "file";
const clients = [];
let browser;
const errors = [];
async function until(check) {
  for (let n = 0; n < 500; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("CONDITION_TIMEOUT");
}
try {
  const repo = join(directory, "repo");
  await mkdir(repo);
  const git = (...args) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  await writeFile(join(repo, "weather.txt"), "cloudy\n");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  );
  await writeFile(join(repo, "weather.txt"), "sunny\n");
  const user = engine.store.createUser(
    "operator",
    "fixture-password-long",
    "member",
  );
  engine.store.put("project", "project", {
    id: "project",
    name: "天気",
    remote: "",
  });
  await engine.listen();
  for (const deviceId of ["owner", "viewer"]) {
    const client = new Client(join(directory, deviceId));
    clients.push(client);
    client.credentials.backend = "file";
    client.checkAccount = async () => {
      client.loginStatus = "login required";
    };
    client.agentCatalog = async () => [];
    await client.start(0);
    engine.store.put("device", deviceId, {
      id: deviceId,
      name: deviceId,
      userId: user.id,
      publicKey: client.settings.publicKey,
      generation: 0,
      revoked: false,
      slots: 1,
      lastAssigned: 0,
      grants: [],
      profile: { name: deviceId },
    });
    engine.store.put("project-member", `project:${deviceId}`, {
      deviceId,
      projectId: "project",
    });
    client.settings.profile = { name: deviceId, context: "" };
    client.settings.deviceId = deviceId;
    client.settings.engineUrl = engine.origin;
    await client.connect();
  }
  const [owner, viewer] = clients;
  await until(() => owner.connected && viewer.connected);
  const task = engine.tasks.createTask({
    projectId: "project",
    meetingId: "meeting",
    authorId: "client-owner",
    text: "明日の天気を調べる",
    requestId: "weather",
    network: false,
  });
  Object.assign(task, {
    clientId: "owner",
    state: "completed",
    result: "明日は晴れです。",
    progress: "turn.completed",
    title: "明日の天気を調べる",
  });
  engine.store.put("task", task.id, task);
  const kinds = [
    { kind: "message", title: "作業メモ", text: "予報を確認しています。" },
    {
      kind: "instruction",
      title: "追加指示",
      text: "東京の天気をお願いします。",
      sender: { id: "owner", name: "owner" },
      sentAt: 2,
    },
    {
      kind: "command",
      title: "コマンドを実行",
      text: "echo sunny",
      output: "sunny",
      exitCode: 0,
    },
    { kind: "tool", title: "Webを検索", text: "Tokyo forecast" },
    {
      kind: "files",
      title: "ファイルを変更",
      files: [{ path: "weather.txt", kind: "update" }],
    },
    { kind: "message", title: "結果", text: task.result },
  ];
  owner.executor.runs[task.runId] = {
    task,
    state: "completed",
    directory: repo,
    result: task.result,
    progress: "turn.completed",
    model: "fixture-model",
    activityVersion: 1,
    contextSources: [
      {
        id: "context",
        title: "参考資料",
        kind: "context",
        text: "場所は東京です。",
      },
    ],
    activity: kinds.map((entry, n) => ({
      ...entry,
      id: `1:${n}`,
      revision: 1,
      at: n + 1,
      updatedAt: n + 1,
      status: "completed",
    })),
  };
  await owner.executor.save();
  engine.flush();
  await until(
    () => !!engine.store.get("task-detail", task.id)?.snapshot.patchAt,
  );
  browser = await chromium.launch({ headless: true });
  const localPage = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
  });
  for (const p of [localPage, page])
    p.on("pageerror", (e) => errors.push(e.message));
  await localPage.goto(owner.origin);
  await page.goto(viewer.origin);
  for (const p of [localPage, page]) {
    await p.locator(`.task-row[data-task-id="${task.id}"] .task-link`).click();
    await p
      .locator(".agent-message")
      .filter({ hasText: "明日は晴れです。" })
      .waitFor();
  }
  for (const selector of [
    ".agent-message",
    ".request-message .message-text",
    ".tool-entry",
  ]) {
    assert.deepEqual(
      await page.locator(selector).allTextContents(),
      await localPage.locator(selector).allTextContents(),
      selector,
    );
  }
  assert.ok(
    !(await page.locator("body").innerText()).includes("turn.completed"),
  );
  assert.equal(
    await page
      .getByRole("button", { name: "タスクを停止", exact: true })
      .count(),
    0,
  );
  assert.equal(
    await page
      .getByRole("button", { name: "この操作を許可", exact: true })
      .count(),
    0,
  );
  await page
    .locator(".tool-entry")
    .filter({ hasText: "コマンドを実行" })
    .locator("summary")
    .click();
  assert.match(await page.locator(".command-output").innerText(), /sunny/);
  await page.getByRole("tab", { name: "変更", exact: true }).click();
  await page.getByText("+sunny", { exact: false }).waitFor();
  await page.getByRole("tab", { name: "ソース", exact: true }).click();
  await page
    .locator(".source-preview")
    .filter({ hasText: "場所は東京です。" })
    .waitFor();
  await page.getByRole("tab", { name: "環境", exact: true }).click();
  assert.match(await page.locator(".task-inspector").innerText(), /main/);
  assert.match(
    await page.locator(".task-inspector").innerText(),
    /fixture-model/,
  );
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/shared-history-signed-out.png",
    fullPage: true,
  });
  owner.settings.engineUrl = undefined;
  owner.ws.close();
  await page
    .getByRole("status")
    .filter({ hasText: "実行PCはオフライン" })
    .waitFor();
  await page.reload();
  await page.locator(`.task-row[data-task-id="${task.id}"] .task-link`).click();
  await page
    .locator(".agent-message")
    .filter({ hasText: "明日は晴れです。" })
    .waitFor();
  await page.screenshot({
    path: ".ido-build/screenshots/shared-history-offline.png",
    fullPage: true,
  });
  // Revoked membership clears previously rendered content.
  engine.store.remove("project-member", "project:viewer");
  engine.connections.broadcastProjects();
  await page
    .locator(".agent-message")
    .filter({ hasText: "明日は晴れです。" })
    .waitFor({ state: "hidden" });
  assert.deepEqual(errors, []);
  console.log(
    "Shared history browser smoke passed: local/remote parity, signed-out viewer, command output, diff, sources, environment, offline reload, membership removal.",
  );
} finally {
  await browser?.close();
  await Promise.all(clients.map((c) => c.close()));
  await engine.close();
  await rm(directory, { recursive: true, force: true });
}
