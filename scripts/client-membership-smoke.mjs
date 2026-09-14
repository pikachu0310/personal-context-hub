// Synthetic local Engine and Clients only; no account, remote model or external post.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Engine } from "../packages/engine/dist/index.js";
import { Client } from "../packages/client/dist/index.js";
const directory = await mkdtemp(join(tmpdir(), "ido-membership-browser-"));
const engine = new Engine({
  directory: join(directory, "engine"),
  port: 0,
  previewPort: 0,
  conversation: false,
});
engine.credentials.backend = "file";
const admin = engine.store.createUser("Admin", "fixture-password", "admin");
const member = engine.store.createUser("Member", "fixture-password", "member");
const clients = [];
let browser;
const until = async (check) => {
  for (let n = 0; n < 200; n++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("SMOKE_TIMEOUT");
};
const connect = async (index) => {
  const client = new Client(join(directory, `client-${index}`));
  client.credentials.backend = "file";
  client.checkAccount = async () => {
    client.loginStatus = "login required";
  };
  await client.start(0);
  if (!engine.store.get("device", `device-${index}`)) {
    client.settings.profile = {
      name: index === 0 ? "Alex" : "Sam",
      context: "",
    };
    engine.store.put("device", `device-${index}`, {
      id: `device-${index}`,
      userId: member.id,
      name: client.settings.profile.name,
      publicKey: client.settings.publicKey,
      revoked: false,
      generation: 0,
      slots: 1,
      lastAssigned: 0,
      grants: [],
    });
    client.settings.deviceId = `device-${index}`;
    client.settings.engineUrl = engine.origin;
    await client.save();
    await client.connect();
  }
  clients[index] = client;
  await until(
    () => client.connected && engine.ready.has(client.settings.deviceId),
  );
  return client;
};
try {
  await engine.listen();
  const a = await connect(0),
    b = await connect(1);
  const project = await a.createProject(
    "Membership project",
    "project-request",
  );
  const invitation = await a.workspaceRequest("project.invite", {
    projectId: project.id,
  });
  await b.workspaceRequest("project.join", { token: invitation.token });
  const task = await a.workspaceRequest("task.create", {
    projectId: project.id,
    requestId: "task-request",
    text: "Lifecycle task",
  });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1360, height: 960 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await context.newPage(),
    other = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  other.on("pageerror", (e) => errors.push(e.message));
  await page.goto(a.origin);
  await other.goto(b.origin);
  const menu = async (p) => {
    await p
      .getByRole("button", {
        name: "Lifecycle taskのタスクメニュー",
        exact: true,
      })
      .first()
      .click();
  };
  await menu(other);
  await other.getByRole("menuitem", { name: "参加する", exact: true }).click();
  await until(
    () => engine.store.get("task", task.id).memberStates["device-1"] === true,
  );
  await page
    .getByRole("img", { name: "参加者: Alex、Sam", exact: true })
    .first()
    .waitFor();
  await menu(page);
  await page.getByRole("menuitem", { name: "退出", exact: true }).click();
  await page
    .getByRole("img", { name: "参加者: Sam", exact: true })
    .first()
    .waitFor();
  await other
    .getByRole("img", { name: "参加者: Sam", exact: true })
    .first()
    .waitFor();
  await menu(other);
  await other.getByRole("menuitem", { name: "退出", exact: true }).click();
  await until(
    () => engine.store.get("task", task.id).memberStates["device-1"] === false,
  );
  assert.ok(engine.store.get("task", task.id));
  await until(
    async () => (await page.locator(".task-row .task-avatars").count()) === 0,
  );
  await menu(page);
  await page.getByRole("menuitem", { name: "参加する", exact: true }).click();
  await page
    .getByRole("img", { name: "参加者: Alex", exact: true })
    .first()
    .waitFor();
  await menu(page);
  await page.getByRole("menuitem", { name: "削除", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "タスクを完全に削除" });
  await dialog.waitFor();
  await until(() =>
    page.evaluate(
      () => globalThis.document.activeElement?.textContent === "キャンセル",
    ),
  );
  await page.waitForTimeout(250);
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/ido-membership-delete-confirm.png",
  });
  await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
  assert.ok(engine.store.get("task", task.id));
  await page
    .getByRole("button", { name: "Membership projectの設定", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "退出", exact: true }).click();
  const leave = page.getByRole("dialog", {
    name: "プロジェクトから退出",
    exact: true,
  });
  await leave.getByText(/先に「ownerを変更」/).waitFor();
  assert.equal(
    await leave
      .getByRole("button", { name: "退出する", exact: true })
      .isDisabled(),
    true,
  );
  await leave.getByRole("button", { name: "キャンセル", exact: true }).click();
  await page
    .getByRole("button", { name: "Membership projectの設定", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "ownerを変更", exact: true })
    .click();
  const transfer = page.getByRole("dialog", {
    name: "ownerを変更",
    exact: true,
  });
  await transfer.getByLabel("新しいowner", { exact: true }).click();
  await page.getByRole("option", { name: "Sam", exact: true }).click();
  await transfer
    .getByRole("button", { name: "権限を移譲する", exact: true })
    .click();
  await until(
    () => engine.store.get("project", project.id).ownerDeviceId === "device-1",
  );
  await page
    .getByRole("button", { name: "Membership projectの設定", exact: true })
    .click();
  await page.getByRole("menuitem", { name: "退出", exact: true }).click();
  await leave.getByRole("button", { name: "退出する", exact: true }).click();
  await page
    .getByRole("button", { name: "Membership projectの設定", exact: true })
    .waitFor({ state: "hidden" });
  assert.ok(engine.store.get("task", task.id));
  await a.workspaceRequest("profile", {
    ...a.settings.profile,
    codexConnected: false,
  });
  assert.ok(!a.settings.projects.some((p) => p.id === project.id));
  await a.close();
  const restartedA = await connect(0);
  await page.goto(restartedA.origin);
  assert.ok(!restartedA.settings.projects.some((p) => p.id === project.id));
  await restartedA.workspaceRequest("project.join", {
    token: invitation.token,
  });
  await page
    .getByRole("button", { name: "Membership projectの設定", exact: true })
    .waitFor();
  assert.equal(
    engine.store.get("task", task.id).memberStates["device-0"],
    false,
  );
  assert.equal(restartedA.allow, false);
  // Offline local cache remains until reconnect; original Git data is preserved.
  const worktree = join(b.directory, "worktrees", task.runId);
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, "keep.txt"), "keep");
  b.executor.runs[task.runId] = {
    task,
    state: "completed",
    directory: worktree,
    result: "offline private result",
  };
  await b.executor.save();
  await b.close();
  await menu(page);
  await page.getByRole("menuitem", { name: "削除", exact: true }).click();
  await page
    .getByRole("dialog", { name: "タスクを完全に削除" })
    .getByRole("button", { name: "完全に削除する", exact: true })
    .click();
  await until(() => !engine.store.get("task", task.id));
  assert.ok(
    engine.store
      .get("task-deletion", task.id)
      .pendingDeviceIds.includes("device-1"),
  );
  const restartedB = await connect(1);
  await until(
    () =>
      !restartedB.executor.runs[task.runId] &&
      !engine.store
        .get("task-deletion", task.id)
        .pendingDeviceIds.includes("device-1"),
  );
  assert.equal(await readFile(join(worktree, "keep.txt"), "utf8"), "keep");
  await assert.rejects(
    restartedA.workspaceRequest("task.create", {
      projectId: project.id,
      requestId: "task-request",
      text: "Lifecycle task",
    }),
    /TASK_DELETED/,
  );
  const session = engine.store.session(admin.id);
  await context.addCookies([
    { name: "ido_session", value: session.token, url: engine.origin },
  ]);
  const dashboard = await context.newPage();
  dashboard.on("pageerror", (e) => errors.push(e.message));
  await dashboard.goto(engine.origin + "/dashboard/");
  await dashboard
    .getByRole("button", { name: "プロジェクト", exact: true })
    .click();
  await dashboard
    .getByRole("button", { name: "Membership project", exact: true })
    .first()
    .click();
  await dashboard
    .getByRole("button", { name: "招待URLをコピー", exact: true })
    .click();
  await dashboard
    .getByRole("dialog", { name: "招待URL", exact: true })
    .waitFor();
  await dashboard.keyboard.press("Escape");
  await dashboard
    .getByRole("button", { name: "Membership project", exact: true })
    .first()
    .click();
  await dashboard
    .getByRole("button", { name: "プロジェクトを完全削除", exact: true })
    .click();
  const projectDelete = dashboard.getByRole("dialog", {
    name: "プロジェクトを完全に削除",
    exact: true,
  });
  assert.equal(
    await projectDelete
      .getByRole("button", { name: "完全に削除する", exact: true })
      .isDisabled(),
    true,
  );
  await projectDelete
    .getByRole("textbox", {
      name: "確認のためプロジェクト名を入力",
      exact: true,
    })
    .fill(project.name);
  await dashboard.waitForTimeout(250);
  await dashboard.screenshot({
    path: ".ido-build/screenshots/ido-membership-project-delete.png",
  });
  await projectDelete
    .getByRole("button", { name: "完全に削除する", exact: true })
    .click();
  await until(() => !engine.store.get("project", project.id));
  await until(
    () =>
      !restartedA.settings.projects.some((p) => p.id === project.id) &&
      !restartedB.settings.projects.some((p) => p.id === project.id),
  );
  assert.deepEqual(errors, []);
  console.log(
    "Membership browser smoke passed: join/leave icons, last-member retention, cancel focus, owner transfer, restart, invite rejoin, offline purge, stale replay, dashboard invite and project deletion.",
  );
} finally {
  await browser?.close();
  for (const client of clients) await client.close();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
}
