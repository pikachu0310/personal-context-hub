import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { Engine } from "../packages/engine/dist/index.js";
import { Client } from "../packages/client/dist/index.js";
const directory = await mkdtemp(join(tmpdir(), "ido-browser-"));
const observations = [];
const coordinator = {
  async createCoordinator({ meetingId, handle, onCheckpoint }) {
    await onCheckpoint?.(
      handle ?? {
        backend: "browser-fixture",
        meetingId,
        threadId: `fixture-${meetingId}`,
      },
    );
    return {
      async run(observation) {
        observations.push(structuredClone(observation));
        return { reply: null, tasks: [], controls: [] };
      },
      steer: async () => false,
      interrupt: async () => {},
      close: async () => {},
    };
  },
};
const engine = new Engine({
  directory: join(directory, "engine"),
  port: 0,
  previewPort: 0,
  conversation: { coordinator, observationIntervalMs: 60_000 },
});
engine.store.createUser("demo", "demo-password-only", "admin");
const client = new Client(join(directory, "client"));
let browser;
try {
  await engine.listen();
  await client.start(0);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(engine.origin + "/admin");
  await page.getByLabel("ユーザー名").fill("demo");
  await page.getByLabel("パスワード").fill("demo-password-only");
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await page
    .getByRole("heading", { name: "セットアップ", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "説明をスキップ" }).click();
  await page.getByRole("button", { name: "説明を再表示" }).waitFor();
  await page.getByText("エラーログ", { exact: true }).click();
  await page.getByText(/記録されたエラーはありません/).waitFor();
  const diagnostic = engine.store.logError(
    Object.assign(new Error("private-provider-message"), {
      code: "insufficient_quota",
      status: 429,
      requestID: "req_browser123",
    }),
    {
      source: "plugin",
      operation: "audio.transcribe",
      model: "gpt-4o-mini-transcribe",
      eventId: "synthetic-input",
    },
  );
  await page.getByText(/OpenAI APIの利用枠が不足しています/).waitFor();
  const diagnosticText = await page.locator("main").innerText();
  assert.ok(diagnosticText.includes(diagnostic.id));
  assert.ok(!diagnosticText.includes("private-provider-message"));
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/engine-diagnostics.png",
    fullPage: true,
  });
  await page.goto(engine.origin + "/dashboard/");
  await page.getByText("プロジェクト", { exact: true }).first().click();
  await page.getByLabel("プロジェクト名").fill("Demo project");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("heading", { name: "Demo project" }).waitFor();
  await page.getByText("会議", { exact: true }).first().click();
  await page.getByLabel("会議名").fill("Planning");
  await page.getByRole("button", { name: "会議を作成", exact: true }).click();
  await page.getByRole("heading", { name: "Planning", exact: true }).waitFor();
  await page.getByLabel("会話に追加").fill("ブラウザから発言を送ります");
  await page.getByRole("button", { name: "会話を送信", exact: true }).click();
  const logText = "[demo] ブラウザから発言を送ります";
  await page.getByText(logText, { exact: true }).waitFor();
  const meeting = engine.store
    .list("meeting")
    .find((entry) => entry.name === "Planning");
  assert.ok(meeting);
  await engine.conversation.coordinated.flush(meeting.id);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].meetingId, meeting.id);
  assert.ok(
    observations[0].events.some(
      (event) =>
        event.type === "message" &&
        event.source.text === "ブラウザから発言を送ります",
    ),
  );
  assert.equal(
    engine.store.get("coordinator", meeting.id).inbox.handle.backend,
    "browser-fixture",
  );
  await page.getByText("議事録", { exact: true }).first().click();
  await page.getByText(logText, { exact: true }).waitFor();
  await page.getByText("成果物", { exact: true }).first().click();
  await page.getByText(/各タスクの実行結果/).waitFor();
  await page.getByText("会議", { exact: true }).first().click();
  await page.screenshot({
    path: ".ido-build/screenshots/dashboard.png",
    fullPage: true,
  });
  await engine.plugins.get("dashboard").stop();
  assert.equal(
    (await page.request.get(engine.origin + "/dashboard/api/state")).status(),
    503,
  );
  await page.goto(engine.origin + "/admin");
  await page
    .getByRole("heading", { name: "セットアップ", exact: true })
    .waitFor();
  const dashboardCard = page
    .getByRole("heading", { name: "Dashboard", exact: true })
    .locator("..")
    .locator("..");
  await dashboardCard
    .getByRole("button", { name: "起動", exact: true })
    .click();
  await dashboardCard.getByText("running", { exact: true }).waitFor();
  const clientPage = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  clientPage.on("pageerror", (error) => errors.push(error.message));
  await clientPage.goto(client.origin);
  await clientPage.getByLabel("EngineのURL").fill(engine.origin);
  await clientPage.getByRole("button", { name: "接続の確認へ" }).click();
  const link = clientPage.getByRole("link", {
    name: "Engineへログインして、この端末を承認する",
  });
  await link.waitFor();
  await page.goto(await link.getAttribute("href"));
  await page.getByRole("button", { name: "この端末を承認する" }).click();
  await clientPage
    .getByText("チームに接続中", { exact: true })
    .first()
    .waitFor({ timeout: 15000 });
  await page.getByText("クライアント", { exact: true }).first().click();
  await page
    .getByRole("heading", { name: "クライアント", exact: true })
    .waitFor();
  await page.getByText("connected", { exact: true }).first().waitFor();
  await page.screenshot({
    path: ".ido-build/screenshots/engine.png",
    fullPage: true,
  });
  await clientPage.screenshot({
    path: ".ido-build/screenshots/client.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForFunction(
    () =>
      globalThis.document.querySelector(".content").getBoundingClientRect()
        .left <= 32,
  );
  await page.screenshot({
    path: ".ido-build/screenshots/mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth + 1,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Browser smoke passed: independent React/Mantine admin, Dashboard, Client; attributed log and persistent coordinator with fake provider; plugin restart; pairing; responsive layout.",
  );
} finally {
  await browser?.close();
  await client.close();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
}
