import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Client } from "../packages/client/dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "ido-project-form-"));
const client = new Client(join(directory, "client"));
client.credentials.backend = "file";
client.checkAccount = async () => {};
let browser;
try {
  await client.start(0);
  client.connected = true;
  client.projectCreationSupported = true;
  client.createProject = async () => ({
    id: "example",
    name: "Example",
    remote: "",
  });
  const projectPath = join(directory, "project");
  await mkdir(projectPath);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1100, height: 900 },
  });
  await page.goto(client.origin);
  await page
    .getByRole("button", { name: "プロジェクトを追加", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByRole("textbox", { name: "名前", exact: true })
    .fill("Example");
  await dialog
    .getByRole("textbox", { name: "保存先", exact: true })
    .fill(projectPath);
  await dialog.getByText("Manual", { exact: true }).click();
  assert.equal(
    await dialog
      .getByRole("switch", { name: "インターネット通信", exact: true })
      .isChecked(),
    true,
  );
  assert.equal(
    await dialog
      .getByRole("switch", { name: "タスクの実行許可", exact: true })
      .isChecked(),
    true,
  );
  await dialog.getByRole("button", { name: "タスクの進め方のヘルプ" }).hover();
  await page.getByRole("tooltip").waitFor();
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: ".ido-build/screenshots/client-project-add.png",
  });
  await dialog.getByRole("button", { name: "追加", exact: true }).click();
  await dialog.waitFor({ state: "hidden" });
  assert.equal(client.settings.mappings[0].progressMode, "manual");
  assert.equal(client.settings.mappings[0].network, true);
  assert.equal(client.allow, true);
  await page
    .getByRole("button", { name: "Exampleの設定", exact: true })
    .press("Enter");
  await page.getByRole("menuitem", { name: "接続・設定", exact: true }).click();
  const allowedResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/allow"),
  );
  await dialog
    .getByRole("switch", { name: "タスクの実行許可", exact: true })
    .press("Space");
  assert.equal((await allowedResponse).status(), 200);
  assert.equal(client.allow, false);
  const networkResponse = page.waitForResponse((response) =>
    response.url().endsWith("/api/mappings"),
  );
  await dialog
    .getByRole("switch", { name: "インターネット通信", exact: true })
    .press("Space");
  assert.equal((await networkResponse).status(), 200);
  assert.equal(client.settings.mappings[0].network, false);
  const controls = await dialog
    .locator(".project-form-control")
    .evaluateAll((elements) =>
      elements.map((element) =>
        Math.round(element.getBoundingClientRect().left),
      ),
    );
  assert.equal(new Set(controls.slice(0, 5)).size, 1);
  await dialog.getByRole("button", { name: "タスクの進め方のヘルプ" }).hover();
  await page.getByRole("tooltip").waitFor();
  await page.screenshot({
    animations: "disabled",
    path: ".ido-build/screenshots/client-project-settings.png",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    animations: "disabled",
    path: ".ido-build/screenshots/client-project-settings-mobile.png",
  });
  assert.ok(
    await dialog.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  );
  console.log(
    "Project forms: creation options, default execution/network On, settings toggle, focus/hover help and mobile layout passed.",
  );
} finally {
  await browser?.close();
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
