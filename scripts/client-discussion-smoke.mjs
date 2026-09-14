// Real loopback Engine + Client; synthetic provider catalog, no model or Discord calls.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Engine } from "../packages/engine/dist/index.js";
import { Client } from "../packages/client/dist/index.js";
import {
  TaskBoard,
  projectDiscussion,
} from "../packages/engine/src/processing/tasks/board.ts";

const directory = await mkdtemp(join(tmpdir(), "ido-discussion-smoke-"));
const engine = new Engine({
  directory: join(directory, "engine"),
  port: 0,
  previewPort: 0,
  conversation: false,
});
const client = new Client(join(directory, "client"));
let browser;
try {
  engine.credentials.backend = "file";
  client.credentials.backend = "file";
  client.checkAccount = async () => {
    client.loginStatus = "authenticated";
  };
  client.agentCatalog = async () => [
    {
      agent: "codex",
      authenticated: true,
      models: [{ id: "fixture-model", name: "Fixture model" }],
    },
    { agent: "claude", authenticated: false, models: [] },
  ];
  const user = engine.store.createUser(
    "fixture",
    "fixture-password-long",
    "member",
  );
  const project = { id: "project", name: "Demo project", remote: "" };
  engine.store.put("project", project.id, project);
  await engine.listen();
  await client.start(0);
  engine.store.put("device", "pc", {
    id: "pc",
    name: "Fixture PC",
    userId: user.id,
    publicKey: client.settings.publicKey,
    revoked: false,
    generation: 0,
    slots: 1,
    lastAssigned: 0,
    grants: [],
  });
  engine.store.put("project-member", "project:pc", {
    projectId: "project",
    deviceId: "pc",
  });
  client.settings.deviceId = "pc";
  client.settings.engineUrl = engine.origin;
  client.settings.mappings = [
    {
      projectId: "project",
      directory,
      slots: 1,
      network: false,
      model: "fixture-model",
    },
  ];
  await client.connect();
  for (
    let i = 0;
    i < 100 && !client.settings.projects.some((p) => p.id === "project");
    i++
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(client.settings.projects.some((p) => p.id === "project"));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(client.origin);
  await page
    .locator('[data-project-id="project"] .collapse-heading')
    .first()
    .hover();
  await page
    .getByRole("button", { name: "Demo projectの設定", exact: true })
    .click();
  await page
    .getByRole("menuitem", { name: "相談・共有（Issueなし）", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "相談・共有への投稿" })
    .fill("APIの共通仕様について相談したいです。");
  await dialog.getByRole("button", { name: "会話に投稿", exact: true }).click();
  await dialog
    .getByText("APIの共通仕様について相談したいです。", { exact: true })
    .waitFor();
  assert.equal(engine.store.list("task").length, 0);
  new TaskBoard(engine.store).post(
    projectDiscussion("project"),
    { body: "長い回答の本文。".repeat(130) },
    "peer-post",
    "Teammate",
    "app",
  );
  await dialog.getByRole("button", { name: "全文を読む" }).click();
  await dialog
    .getByRole("button", { name: "全文を読む" })
    .waitFor({ state: "hidden" });
  await dialog.getByRole("button", { name: "タスクにする" }).first().click();
  await dialog
    .getByText("タスクを作成しました。プロジェクトの一覧から開けます。")
    .waitFor();
  assert.equal(engine.store.list("task").length, 1);
  assert.equal(engine.store.list("task")[0].model, "fixture-model");
  await mkdir(".ido-build", { recursive: true });
  await page.screenshot({ path: ".ido-build/discussion-smoke.png" });
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "このPCで新しいタスク", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "Gitリポジトリのフォルダー" })
    .waitFor();
  await page.getByRole("button", { name: "エージェント", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Codex/ }).waitFor();
  assert.equal(
    await page
      .getByRole("menuitem", { name: "Claude Code", exact: true })
      .count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS: project discussion, full text, explicit task creation, local launch entry and authenticated provider picker",
  );
} finally {
  await browser?.close();
  await client.close();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
}
