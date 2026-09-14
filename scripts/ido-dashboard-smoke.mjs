import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { chromium } from "playwright";
import { Engine } from "../packages/engine/dist/index.js";
const directory = await mkdtemp(join(tmpdir(), "ido-dashboard-smoke-"));
const engine = new Engine({
  directory,
  port: 0,
  previewPort: 0,
  conversation: false,
});
engine.credentials.backend = "file";
const users = ["青木", "森", "佐藤", "田中", "高橋", "伊藤"].map((name, i) =>
  engine.store.createUser(
    name,
    "fixture-password-only",
    i === 0 ? "admin" : "member",
  ),
);
const sockets = [];
let browser;
const until = async (check) => {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("FIXTURE_TIMEOUT");
};
try {
  await engine.listen();
  clearInterval(engine.timer);
  const projects = [
    { id: "default", name: "Atlas", remote: "", isDefault: true },
    { id: "beacon", name: "Beacon", remote: "" },
    { id: "cedar", name: "Cedar", remote: "" },
  ];
  for (const p of projects) engine.store.put("project", p.id, p);
  engine.plugins.get("discord").manifest = {
    id: "discord",
    version: "0.2.0",
    protocol: 2,
    title: "Discord Bot + Activity",
    fields: [],
    capabilities: ["project-conversation"],
  };
  engine.store.put("config", "discord", { projectId: "default" });
  const now = Date.now();
  for (const p of projects) {
    engine.store.put("meeting", `meeting-${p.id}`, {
      id: `meeting-${p.id}`,
      projectId: p.id,
      name: `${p.name}の会話`,
      startedAt: now - 3600000,
      summary: `${p.name} の議事録サンプル`,
      messages: [],
    });
    engine.store.put("project-conversation", p.id, {
      projectId: p.id,
      meetingId: `meeting-${p.id}`,
      lastHumanAt: p.id === "cedar" ? now - 3600000 : now,
    });
  }
  const ids = [
    "worker-a1",
    "worker-m1",
    "worker-s1",
    "worker-t1",
    "worker-h1",
    "worker-i1",
  ];
  for (let i = 0; i < users.length; i++) {
    const keys = generateKeyPairSync("ed25519"),
      id = ids[i],
      projectId = i < 2 || i === 4 ? "default" : i === 5 ? "cedar" : "beacon";
    engine.store.put("device", id, {
      id,
      name: id,
      userId: users[i].id,
      publicKey: keys.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
      revoked: false,
      generation: 0,
      grants: [],
      slots: 1,
      lastAssigned: 0,
    });
    engine.store.put("project-member", `${projectId}:${id}`, {
      projectId,
      deviceId: id,
    });
    if (i >= 4) continue;
    const ws = new WebSocket(
      engine.origin.replace("http:", "ws:") + "/connect",
    );
    sockets.push(ws);
    ws.on("message", (raw) => {
      const cmd = JSON.parse(raw.toString());
      if (cmd.id)
        ws.send(
          JSON.stringify({
            v: 1,
            type: "ack",
            generation: cmd.generation,
            id: cmd.id,
          }),
        );
      if (cmd.type === "challenge")
        ws.send(
          JSON.stringify({
            v: 1,
            type: "authenticate",
            lifecycleVersion: 1,
            deviceId: id,
            profile: { name: id, codexConnected: true },
            signature: sign(
              null,
              Buffer.from(`ido:1:${id}:${cmd.challenge}`),
              keys.privateKey,
            ).toString("base64"),
          }),
        );
      else if (cmd.type === "authenticated") {
        if (projectId !== "default")
          engine.store.remove("project-member", `default:${id}`);
        ws.send(
          JSON.stringify({
            v: 1,
            type: "ready",
            generation: cmd.generation,
            profile: { name: id, codexConnected: true },
            grants: i === 3 ? [] : [{ projectId, slots: 1, network: false }],
            slots: 1,
          }),
        );
      } else if (["execute", "stop"].includes(cmd.type))
        ws.send(
          JSON.stringify({
            v: 1,
            type: "result",
            generation: cmd.generation,
            taskId: cmd.taskId,
            runId: cmd.runId,
            revision: cmd.task.revision,
            state: cmd.type === "execute" ? "running" : "cancelled",
            controlReceipts: cmd.receiptId
              ? [
                  {
                    id: cmd.receiptId,
                    controlVersion: cmd.controlVersion,
                    delivery: "stopped",
                  },
                ]
              : [],
          }),
        );
    });
    await until(() => engine.ready.has(id));
    // Authentication creates default membership; the fixture explicitly models the intended project.
    if (projectId !== "default")
      engine.store.remove("project-member", `default:${id}`);
  }
  const titles = [
    "検索APIの改善",
    "画面テストの更新",
    "集計処理の検証",
    "通知文面の調整",
    "導線レビュー",
  ];
  const tasks = titles.map((title, i) =>
    engine.tasks.createTask({
      projectId: i < 2 ? "default" : i < 4 ? "beacon" : "cedar",
      meetingId: `meeting-${i < 2 ? "default" : i < 4 ? "beacon" : "cedar"}`,
      authorId: users[0].id,
      title,
      text: title,
      requestId: `request-${i}`,
      network: false,
    }),
  );
  engine.flush();
  await until(
    () =>
      engine.store.list("task").filter((t) => t.state === "running").length ===
      3,
  );
  for (let i = 0; i < 144; i++)
    engine.store.put("message", `sample-${i}`, {
      id: `sample-${i}`,
      meetingId: "meeting-default",
      authorId: users[0].id,
      text:
        i === 0
          ? "<script>globalThis.rawExecuted=true</script>"
          : "検証用の発言",
      at: now - 1000 - i * 20000,
      role: "user",
      complete: true,
      stage: "completed",
    });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
      viewport: { width: 1672, height: 941 },
    }),
    page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(engine.origin + "/dashboard/");
  await page.getByText("管理者アカウントでログインしてください。").waitFor();
  const session = engine.store.session(users[0].id);
  await context.addCookies([
    {
      name: "ido_session",
      value: session.token,
      url: engine.origin,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  await page.reload();
  await page.getByRole("heading", { name: "概要", exact: true }).waitFor();
  await page.getByText("エンジン接続中", { exact: false }).waitFor();
  await page
    .getByText("Discord Bot + Activity の参加先: Atlas", { exact: true })
    .waitFor();
  engine.store.put("config", "discord", { projectId: "beacon" });
  await page
    .getByText("Discord Bot + Activity の参加先: Beacon", { exact: true })
    .waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: /会話を送信|タスクを作成|追加指示/ })
      .count(),
    0,
  );
  assert.deepEqual(await page.locator(".metric-value").allTextContents(), [
    "3",
    "2",
    "4",
    "2",
    "3",
  ]);
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/ido-dashboard-overview.png",
    fullPage: true,
    animations: "disabled",
  });
  // A filter changes counts while retaining project names for switching back.
  await page.getByRole("combobox", { name: "プロジェクトで絞り込む" }).click();
  await page.getByRole("option", { name: "Beacon", exact: true }).click();
  await page.waitForFunction(
    () =>
      globalThis.document.querySelectorAll(".metric-value")[0]?.textContent ===
      "1",
  );
  await page.getByRole("combobox", { name: "プロジェクトで絞り込む" }).click();
  await page
    .getByRole("option", { name: "全プロジェクト", exact: true })
    .click();
  await page.waitForFunction(
    () =>
      globalThis.document.querySelectorAll(".metric-value")[0]?.textContent ===
      "3",
  );
  // Queued task stop, confirmation cancellation, then a real command against the fixture.
  await page.getByRole("button", { name: "導線レビュー", exact: true }).click();
  await page
    .getByRole("button", { name: "タスクを強制停止", exact: true })
    .click();
  let modal = page.getByRole("dialog").filter({
    has: page.getByText("このタスクを強制停止しますか？", { exact: true }),
  });
  await modal.getByRole("button", { name: "キャンセル", exact: true }).click();
  assert.equal(engine.store.get("task", tasks[4].id).state, "queued");
  await page
    .getByRole("button", { name: "タスクを強制停止", exact: true })
    .click();
  await modal
    .getByRole("button", { name: "タスクを強制停止", exact: true })
    .click();
  await until(
    () => engine.store.get("task", tasks[4].id).state === "cancelled",
  );
  await page.getByText("停止確認済み", { exact: true }).first().waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "ユーザ・接続", exact: true }).click();
  await page.getByRole("button", { name: "佐藤", exact: true }).click();
  await page
    .getByRole("button", { name: "この接続を切断", exact: true })
    .click();
  modal = page.getByRole("dialog").filter({
    has: page.getByText("この接続を切断しますか？", { exact: true }),
  });
  await modal.waitFor();
  await modal.getByText(/集計処理の検証/).waitFor();
  await page.screenshot({
    path: ".ido-build/screenshots/ido-dashboard-disconnect.png",
    fullPage: true,
    animations: "disabled",
  });
  await modal.getByRole("button", { name: "接続を切断", exact: true }).click();
  await until(() => !engine.peers.has("worker-s1"));
  assert.equal(engine.store.get("device", "worker-s1").revoked, false);
  assert.equal(engine.store.get("task", tasks[3].id).state, "queued");
  await page.getByText(/対象タスクの停止を確認しました/).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "生データ", exact: true }).click();
  await page.getByText(/globalThis.rawExecuted/).waitFor();
  assert.equal(await page.evaluate(() => globalThis.rawExecuted), undefined);
  assert.equal(await page.locator(".raw-log section").count(), 50);
  await page.getByRole("button", { name: "2", exact: true }).click();
  await page.locator(".raw-log section").first().waitFor();
  // Stale snapshots retain the last values but cannot send destructive commands.
  await page.getByRole("button", { name: "概要", exact: true }).click();
  await page.route(/\/api\/admin\/dashboard(?:\?.*)?$/, (route) =>
    route.abort(),
  );
  await page.getByText("● 通信断・古い情報", { exact: true }).waitFor();
  await page
    .getByRole("button", { name: "検索APIの改善", exact: true })
    .click();
  assert.equal(
    await page
      .getByRole("button", { name: "タスクを強制停止", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  await page.screenshot({
    path: ".ido-build/screenshots/ido-dashboard-offline.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.unroute(/\/api\/admin\/dashboard(?:\?.*)?$/);
  await page.getByText("● エンジン接続中", { exact: true }).waitFor();
  for (const width of [1366, 390]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: `.ido-build/screenshots/ido-dashboard-${width}.png`,
      fullPage: true,
      animations: "disabled",
    });
  }
  await page.setViewportSize({ width: 1672, height: 941 });
  // The entire task row opens details, including status and empty cell padding.
  const activeRow = page.locator("tr").filter({
    has: page.getByRole("button", { name: "検索APIの改善", exact: true }),
  });
  await activeRow.locator("td").nth(2).click();
  await page
    .getByRole("button", { name: "タスクを強制削除", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await activeRow
    .locator("td")
    .nth(6)
    .click({ position: { x: 3, y: 3 } });
  await page
    .getByRole("button", { name: "タスクを強制削除", exact: true })
    .click();
  let deletion = page.getByRole("dialog", {
    name: "タスクを完全に削除",
    exact: true,
  });
  await deletion.getByText(/停止確認を待たず削除/).waitFor();
  await deletion
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  assert.ok(engine.store.get("task", tasks[0].id));
  await page.keyboard.press("Escape");
  await activeRow
    .getByRole("button", { name: "検索APIの改善", exact: true })
    .focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "タスクを強制削除", exact: true })
    .click();
  // A rejected deletion remains reviewable and can be retried with a fresh confirmation.
  await page.route("**/api/admin/dashboard/task/delete", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ error: "WORKSPACE_CONFLICT" }),
    }),
  );
  await deletion
    .getByRole("button", { name: "完全に削除する", exact: true })
    .click();
  await deletion
    .getByRole("alert")
    .filter({ hasText: "状態が変わりました" })
    .waitFor();
  assert.ok(engine.store.get("task", tasks[0].id));
  await page.unroute("**/api/admin/dashboard/task/delete");
  await deletion
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await page
    .getByRole("button", { name: "タスクを強制削除", exact: true })
    .click();
  await deletion
    .getByRole("button", { name: "完全に削除する", exact: true })
    .click();
  await until(() => !engine.store.get("task", tasks[0].id));
  await deletion.waitFor({ state: "hidden" });
  await page
    .getByRole("dialog", { name: /^(タスク|プロジェクト)詳細$/ })
    .waitFor({ state: "hidden" });
  await activeRow.waitFor({ state: "hidden" });
  // Project rows support cell padding and keyboard activation too; default remains protected.
  const defaultRow = page
    .locator("tr")
    .filter({ has: page.getByRole("button", { name: "Atlas", exact: true }) });
  await defaultRow.locator("td").nth(2).click();
  assert.equal(
    await page
      .getByRole("button", { name: "プロジェクトを完全削除", exact: true })
      .isDisabled(),
    true,
  );
  await page.keyboard.press("Escape");
  const projectRow = page
    .locator("tr")
    .filter({ has: page.getByRole("button", { name: "Beacon", exact: true }) });
  await projectRow
    .locator("td")
    .nth(4)
    .click({ position: { x: 3, y: 3 } });
  await page
    .getByRole("button", { name: "プロジェクトを完全削除", exact: true })
    .waitFor();
  await page.keyboard.press("Escape");
  await projectRow.getByRole("button", { name: "Beacon", exact: true }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("button", { name: "プロジェクトを完全削除", exact: true })
    .click();
  deletion = page.getByRole("dialog", {
    name: "プロジェクトを完全に削除",
    exact: true,
  });
  assert.equal(
    await deletion
      .getByRole("button", { name: "完全に削除する", exact: true })
      .isDisabled(),
    true,
  );
  await deletion
    .getByRole("button", { name: "キャンセル", exact: true })
    .click();
  await page.keyboard.press("Escape");
  // A project containing an offline, stop-unconfirmed task can be deleted while filtered.
  const offline = engine.store.get("task", tasks[3].id);
  offline.state = "interrupted";
  offline.clientId = "worker-s1";
  offline.controlReceipts = {
    stop: { id: "stop", type: "stop", delivery: "uncertain" },
  };
  engine.store.put("task", offline.id, offline);
  await page.getByRole("combobox", { name: "プロジェクトで絞り込む" }).click();
  await page.getByRole("option", { name: "Beacon", exact: true }).click();
  await page
    .getByRole("button", { name: "通知文面の調整", exact: true })
    .waitFor();
  await projectRow.locator("td").nth(2).click();
  await page
    .getByRole("button", { name: "プロジェクトを完全削除", exact: true })
    .click();
  await deletion
    .getByText(/配下の実行中タスクも停止確認を待たず削除/)
    .waitFor();
  await deletion
    .getByRole("textbox", { name: "確認のためプロジェクト名を入力" })
    .fill("Beacon");
  await deletion
    .getByRole("button", { name: "完全に削除する", exact: true })
    .click();
  await until(() => !engine.store.get("project", "beacon"));
  await deletion.waitFor({ state: "hidden" });
  await page
    .getByRole("dialog", { name: /^(タスク|プロジェクト)詳細$/ })
    .waitFor({ state: "hidden" });
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector(
        'input[aria-label="プロジェクトで絞り込む"]',
      )?.value === "全プロジェクト",
  );
  await defaultRow.waitFor();
  assert.equal(engine.store.get("task", offline.id), undefined);
  assert.ok(engine.store.get("task-deletion", offline.id));
  await page.screenshot({
    path: ".ido-build/screenshots/ido-dashboard-deletion.png",
    fullPage: true,
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log(
    "IDO Dashboard browser smoke passed: real admin APIs, counts, filters, stop, generation-bound disconnect, raw escaping/paging, offline controls, row activation, force deletion, project filter reset, 1672/1366/390px layouts.",
  );
} finally {
  await browser?.close();
  for (const ws of sockets) ws.terminate();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
}
