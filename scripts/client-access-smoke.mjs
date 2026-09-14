// Real Client API and UI with synthetic settings/catalog; no model or Bot calls.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Client } from "../packages/client/dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "ido-access-ui-"));
const client = new Client(join(directory, "client"));
client.credentials.backend = "file";
client.checkAccount = async () => {
  client.loginStatus = "authenticated";
};
client.agentCatalog = async () => [
  {
    agent: "codex",
    authenticated: true,
    models: [{ id: "test-model", name: "Test" }],
  },
];
let browser;
try {
  await client.start(0);
  client.connected = true;
  client.settings.projects = [{ id: "project", name: "Demo", remote: "" }];
  client.settings.mappings = [
    {
      projectId: "project",
      directory,
      network: false,
      slots: 1,
      progressMode: "auto",
      accessMode: "full",
    },
  ];
  client.allowedProjects.add("project");
  await client.save();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
  });
  await page.goto(client.origin);
  await mkdir(".ido-build/screenshots", { recursive: true });
  const dialog = page.getByRole("dialog");
  const openSettings = async () => {
    await page
      .getByRole("button", { name: "Demoの設定", exact: true })
      .press("Enter");
    await page
      .getByRole("menuitem", { name: "接続・設定", exact: true })
      .click();
    await dialog.getByText("詳細設定", { exact: true }).click();
  };
  await openSettings();
  const select = dialog.getByLabel("新しいタスクの権限", { exact: true });
  const choose = async (label) => {
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith("/api/access-mode")),
      (async () => {
        await select.click();
        await page.getByRole("option", { name: label, exact: true }).click();
      })(),
    ]);
    assert.equal(response.status(), 200);
    await page.waitForFunction(
      () =>
        !globalThis.document.querySelector('[aria-label="新しいタスクの権限"]')
          .disabled,
    );
    assert.equal(await select.inputValue(), label);
  };
  const options = [
    ["sandbox", "サンドボックス内で実行"],
    ["approval", "許可を求める"],
    ["full", "フルアクセス"],
  ];
  for (const mode of ["manual", "auto"]) {
    const response = page.waitForResponse((r) =>
      r.url().endsWith("/api/progress-mode"),
    );
    await dialog
      .getByText(mode === "auto" ? "Auto" : "Manual", { exact: true })
      .click();
    assert.equal((await response).status(), 200);
    for (const [value, label] of options) {
      await choose(label);
      assert.equal(client.settings.mappings[0].accessMode, value);
      assert.equal(client.settings.mappings[0].progressMode, mode);
      assert.equal(client.settings.mappings[0].network, false);
      assert.equal(client.allowedProjects.has("project"), true);
    }
  }
  // Selection also works without a pointer.
  await select.focus();
  await select.press("ArrowDown");
  await select.press("ArrowUp");
  await select.press("ArrowUp");
  const keyboardSave = page.waitForResponse((r) =>
    r.url().endsWith("/api/access-mode"),
  );
  await page.keyboard.press("Enter");
  assert.equal((await keyboardSave).status(), 200);
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector('[aria-label="新しいタスクの権限"]')
        .value === "サンドボックス内で実行",
  );
  await page.route("**/api/access-mode", (route) =>
    route.fulfill({ status: 503, json: { error: "TEST_SAVE_FAILED" } }),
  );
  await select.click();
  await page.getByRole("option", { name: "フルアクセス", exact: true }).click();
  await dialog
    .getByRole("alert")
    .filter({ hasText: "TEST_SAVE_FAILED" })
    .waitFor();
  assert.equal(await select.inputValue(), "サンドボックス内で実行");
  assert.equal(client.settings.mappings[0].accessMode, "sandbox");
  await page.unroute("**/api/access-mode");
  await page.reload();
  await openSettings();
  assert.equal(await select.inputValue(), "サンドボックス内で実行");
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/access-project-settings.png",
  });
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Demoに新しいタスクを追加", exact: true })
    .click();
  const input = page.getByLabel("新しいタスクへの依頼");
  await input.fill("Fixture draft");
  const dropdown = page.getByRole("button", {
    name: "新しいタスクの権限",
    exact: true,
  });
  await dropdown.filter({ hasText: "サンドボックス内で実行" }).waitFor();
  let release;
  await page.route("**/api/access-mode", async (route) => {
    await new Promise((resolve) => {
      release = resolve;
    });
    await route.continue();
  });
  await dropdown.click();
  await page
    .getByRole("menuitem", { name: "許可を求める", exact: true })
    .click();
  assert.ok(await dropdown.isDisabled());
  assert.ok(
    await page.getByRole("button", { name: "送信", exact: true }).isDisabled(),
  );
  while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
  release();
  await dropdown.filter({ hasText: "許可を求める" }).waitFor();
  await page.unroute("**/api/access-mode");
  await page.route("**/api/access-mode", (route) =>
    route.fulfill({ status: 503, json: { error: "TEST_SAVE_FAILED" } }),
  );
  await dropdown.click();
  await page
    .getByRole("menuitem", { name: "フルアクセス", exact: true })
    .click();
  await page
    .getByRole("alert")
    .filter({ hasText: "TEST_SAVE_FAILED" })
    .waitFor();
  assert.ok((await dropdown.innerText()).includes("許可を求める"));
  await page.unroute("**/api/access-mode");
  await dropdown.click();
  await page
    .getByRole("menuitem", { name: "サンドボックス内で実行", exact: true })
    .click();
  await dropdown.filter({ hasText: "サンドボックス内で実行" }).waitFor();
  await page.screenshot({
    animations: "disabled",
    path: ".ido-build/screenshots/access-new-task.png",
  });
  await openSettings();
  assert.equal(await select.inputValue(), "サンドボックス内で実行");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () =>
      Number(
        globalThis.getComputedStyle(
          globalThis.document.querySelector('[role="dialog"]'),
        ).opacity,
      ) === 1,
  );
  await page.screenshot({
    animations: "disabled",
    path: ".ido-build/screenshots/access-project-mobile.png",
  });
  assert.ok(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  );
  console.log(
    "Access UI: mode independence, downgrade, persistence, settings/composer sync, failure recovery, keyboard and mobile passed.",
  );
} catch (error) {
  const page = browser?.contexts()[0]?.pages()[0];
  console.error(
    await page
      ?.locator("body")
      .innerText()
      .catch(() => ""),
  );
  await page
    ?.screenshot({ path: ".ido-build/screenshots/access-failure.png" })
    .catch(() => {});
  throw error;
} finally {
  await browser?.close();
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
