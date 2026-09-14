import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  // Setup uses text credentials, reports server storage, and never requires a plugin.
  const keyInput = page.getByRole("textbox", { name: /^OpenAI APIキー/ });
  assert.equal(await keyInput.getAttribute("type"), "text");
  assert.equal(await keyInput.getAttribute("autocomplete"), "off");
  assert.equal(await page.locator('input[type="password"]').count(), 0);
  await page
    .getByText(join(directory, "engine", "secrets.json"), { exact: true })
    .waitFor();
  await keyInput.fill("synthetic-browser-key");
  await page
    .getByRole("button", { name: "保存して公開URLへ", exact: true })
    .click();
  await page.getByRole("heading", { name: "公開URLを設定" }).waitFor();
  await page.getByRole("button", { name: "ローカルのみで続ける" }).click();
  await page
    .getByRole("button", { name: "インストール", exact: true })
    .waitFor();
  assert.equal(await page.getByLabel("Botトークン（変更時のみ）").count(), 0);
  await page
    .getByRole("button", { name: "プラグインはあとで設定して完了" })
    .click();
  await page.getByText("基本設定が完了しました", { exact: true }).waitFor();
  assert.equal(
    engine.plugins.state().find((p) => p.id === "discord").installed,
    undefined,
  );
  await page.getByRole("button", { name: "1 OpenAI", exact: true }).click();
  assert.equal(await keyInput.inputValue(), "********");
  assert.equal(await keyInput.getAttribute("readonly"), "");
  await page
    .getByRole("button", { name: "OpenAI APIキーを変更", exact: true })
    .click();
  await keyInput.fill("discarded-browser-key");
  await page
    .getByRole("button", {
      name: "OpenAI APIキーを変更せずに戻る",
      exact: true,
    })
    .click();
  await page
    .getByRole("button", { name: "保存して公開URLへ", exact: true })
    .click();
  await page.getByRole("heading", { name: "公開URLを設定" }).waitFor();
  assert.equal(await engine.credentials.get("openai"), "synthetic-browser-key");
  await page.getByRole("button", { name: "1 OpenAI", exact: true }).click();
  await page
    .getByRole("button", { name: "OpenAI APIキーを変更", exact: true })
    .click();
  await keyInput.fill("replacement-browser-key");
  await page
    .getByRole("button", { name: "保存して公開URLへ", exact: true })
    .click();
  await page.getByRole("heading", { name: "公開URLを設定" }).waitFor();
  assert.equal(
    await engine.credentials.get("openai"),
    "replacement-browser-key",
  );
  await engine.credentials.set("tunnel.ngrok", "synthetic-browser-tunnel");
  await page.reload();
  await page.getByRole("button", { name: "2 公開URL", exact: true }).click();
  await page.getByRole("combobox", { name: "公開方法" }).click();
  await page.getByRole("option", { name: "ngrokで公開" }).click();
  assert.equal(
    await page.getByRole("textbox", { name: /^ngrok Authtoken/ }).inputValue(),
    "********",
  );
  await page.getByRole("combobox", { name: "公開方法" }).click();
  await page.getByRole("option", { name: "Cloudflareで公開" }).click();
  assert.equal(
    await page
      .getByRole("textbox", { name: /^Cloudflare Tunnelトークン/ })
      .inputValue(),
    "",
  );
  await page.getByRole("button", { name: "1 OpenAI", exact: true }).click();
  assert.equal(await keyInput.inputValue(), "********");
  const setupState = await (
    await page.request.get(engine.origin + "/api/admin/state")
  ).text();
  assert.ok(!setupState.includes("replacement-browser-key"));
  assert.ok(!setupState.includes("synthetic-browser-tunnel"));
  await mkdir(".ido-build/screenshots", { recursive: true });
  // Include tablet/sidebar widths: a wide viewport can still leave too little
  // content space for three cards. Compare the visible card edges, not wrappers.
  const stepCards = page
    .getByRole("button", { name: /^[123] (OpenAI|公開URL|プラグイン接続)$/ })
    .locator(":scope > .mantine-Paper-root");
  for (const width of [320, 390, 768, 820, 1024, 1120, 1280, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    // AppShell animates its padding across the sidebar breakpoint. Measure the
    // completed layout, not the transient narrow space during that transition.
    await page.locator(".mantine-AppShell-main").evaluate(async (element) => {
      await Promise.all(
        element
          .getAnimations()
          .map((animation) => animation.finished.catch(() => {})),
      );
    });
    const boxes = await stepCards.evaluateAll((cards) =>
      cards.map((card) => {
        const { x, y, width, height } = card.getBoundingClientRect();
        return { x, y, width, height };
      }),
    );
    assert.equal(boxes.length, 3);
    assert.ok(
      Math.max(...boxes.map((box) => box.height)) -
        Math.min(...boxes.map((box) => box.height)) <
        1,
      `step card heights at ${width}px`,
    );
    if (width <= 1120) {
      assert.ok(
        boxes.every((box) => Math.abs(box.x - boxes[0].x) < 1),
        `single column at ${width}px`,
      );
      assert.ok(
        boxes[1].y >= boxes[0].y + boxes[0].height &&
          boxes[2].y >= boxes[1].y + boxes[1].height,
        `no overlap at ${width}px`,
      );
    } else {
      assert.ok(
        boxes.every((box) => Math.abs(box.y - boxes[0].y) < 1),
        `aligned card tops at ${width}px`,
      );
      assert.ok(
        boxes[1].x >= boxes[0].x + boxes[0].width &&
          boxes[2].x >= boxes[1].x + boxes[1].width,
        `three columns at ${width}px`,
      );
    }
    assert.equal(
      await page.evaluate(
        () =>
          globalThis.document.documentElement.scrollWidth <=
          globalThis.innerWidth + 1,
      ),
      true,
      `no horizontal overflow at ${width}px`,
    );
    if (width === 1024)
      await page.screenshot({
        path: ".ido-build/screenshots/setup-tablet.png",
        fullPage: true,
      });
  }
  await page.screenshot({
    path: ".ido-build/screenshots/setup-openai.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".ido-build/screenshots/setup-mobile.png",
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
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole("button", { name: "2 公開URL", exact: true }).click();
  await page.screenshot({
    path: ".ido-build/screenshots/setup-public-url.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "3 プラグイン接続", exact: true })
    .click();
  await page.screenshot({
    path: ".ido-build/screenshots/setup-plugins.png",
    fullPage: true,
  });
  // A locally installed fixture exercises plugin credentials without contacting Discord/npm.
  engine.plugins.catalog.find((entry) => entry.id === "discord").builtin =
    fileURLToPath(
      new URL("../packages/plugin-discord/dist/index.js", import.meta.url),
    );
  await engine.plugins.configure("discord", {
    botToken: "synthetic-plugin-token",
    userPolicy: "allowlist",
    allowedUserIds: "123,456",
  });
  await page.reload();
  await page
    .getByRole("button", { name: "3 プラグイン接続", exact: true })
    .click();
  await page.getByRole("button", { name: "設定する", exact: true }).click();
  const botToken = page.getByRole("textbox", { name: /^Botトークン/ });
  assert.equal(await botToken.inputValue(), "********");
  assert.equal(await botToken.getAttribute("type"), "text");
  assert.equal(
    await page
      .getByRole("textbox", { name: /^OAuthクライアントシークレット/ })
      .inputValue(),
    "",
  );
  const configSaved = page.waitForResponse((response) =>
    response.url().endsWith("/api/admin/plugins/configure"),
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  assert.equal((await configSaved).status(), 200);
  assert.equal(
    await engine.credentials.get("discord.botToken"),
    "synthetic-plugin-token",
  );
  assert.equal(await botToken.inputValue(), "********");
  assert.equal(await page.locator('input[type="password"]').count(), 0);
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
  await page
    .getByRole("button", { name: "3 プラグイン接続", exact: true })
    .click();
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
