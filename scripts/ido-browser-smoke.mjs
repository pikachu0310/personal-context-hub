import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Engine } from "../packages/engine/dist/index.js";
import { Client } from "../packages/client/dist/index.js";
const directory = await mkdtemp(join(tmpdir(), "ido-browser-"));
const engine = new Engine({
  directory: join(directory, "engine"),
  port: 0,
  previewPort: 0,
});
engine.credentials.backend = "file";
engine.store.createUser("demo", "demo-password-only", "admin");
const client = new Client(join(directory, "client"));
client.credentials.backend = "file";
let browser;
try {
  await engine.listen();
  await client.start(0);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(engine.origin);
  await page.getByLabel("ユーザー名").fill("demo");
  await page.getByLabel("パスワード").fill("demo-password-only");
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await page
    .getByRole("heading", { name: "チームの状況", exact: true })
    .waitFor();
  await page.getByText("プロジェクト", { exact: true }).click();
  await page.getByLabel("プロジェクト名").fill("Demo project");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("heading", { name: "Demo project" }).waitFor();
  await page.getByText("会議・議事録", { exact: true }).click();
  await page.getByLabel("会議名").fill("Planning");
  await page.getByRole("button", { name: "会議を作成", exact: true }).click();
  await page.getByRole("heading", { name: "Planning", exact: true }).waitFor();
  await page.getByText("セットアップ", { exact: true }).first().click();
  await page
    .getByRole("heading", { name: "1. 会話を処理するOpenAI API" })
    .waitFor();
  await page.getByRole("button", { name: "説明をスキップ" }).click();
  await page.getByRole("button", { name: "説明を再表示" }).waitFor();
  await page.getByRole("button", { name: "5. 公開URL" }).click();
  assert.equal(
    await page.getByLabel("Preview公開URL", { exact: true }).count(),
    0,
  );
  let tunnelRequest;
  engine.tunnels.start = async (provider, ports, url) => {
    tunnelRequest = { provider, ports, url };
    engine.store.put("config", "public", {
      provider,
      engineUrl: "https://assigned.ngrok-free.app",
    });
    engine.tunnels.status = "running; diagnostics required";
  };
  await page
    .getByLabel("ngrok Authtoken（保存済みなら省略可）")
    .fill("synthetic-test-token");
  await page
    .getByRole("button", { name: "ngrokで公開する", exact: true })
    .click();
  await page
    .getByRole("link", { name: "https://assigned.ngrok-free.app", exact: true })
    .waitFor();
  assert.equal(tunnelRequest.provider, "ngrok");
  assert.equal(tunnelRequest.url, undefined);
  assert.equal(tunnelRequest.ports.engine, Number(new URL(engine.origin).port));
  assert.equal(
    await page.getByLabel("ngrok Authtoken（保存済みなら省略可）").inputValue(),
    "",
  );
  // Restore local setup before pairing a test Client.
  engine.store.remove("config", "public");
  const clientPage = await browser.newPage();
  await clientPage.goto(client.origin);
  await clientPage.getByLabel("EngineのURL").fill(engine.origin);
  await clientPage.getByRole("button", { name: "接続の確認へ" }).click();
  const link = clientPage.getByRole("link", {
    name: "Engineへログインして、この端末を承認する",
  });
  await link.waitFor();
  const url = await link.getAttribute("href");
  await page.goto(url);
  await page.getByRole("button", { name: "この端末を承認する" }).click();
  await clientPage
    .getByText("connected", { exact: true })
    .first()
    .waitFor({ timeout: 15000 });
  await page.getByText("クライアント", { exact: true }).first().click();
  await page
    .getByRole("heading", { name: "クライアント", exact: true })
    .waitFor();
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/engine.png",
    fullPage: true,
    animations: "disabled",
  });
  await clientPage.screenshot({
    path: ".ido-build/screenshots/client.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () =>
      parseFloat(
        globalThis.getComputedStyle(globalThis.document.querySelector("main"))
          .paddingLeft,
      ) < 40,
  );
  await page.evaluate(() => globalThis.scrollTo(0, 0));
  await page.screenshot({
    path: ".ido-build/screenshots/mobile.png",
    fullPage: true,
    animations: "disabled",
  });
  assert.deepEqual(errors, []);
  console.log(
    "Browser smoke passed: login, project, meeting, skip guidance, Client pairing, responsive rendering.",
  );
} finally {
  await browser?.close();
  await client.close();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
}
