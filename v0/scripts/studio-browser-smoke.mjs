/* global document */
// Synthetic execution for deterministic interaction checks. The separate live
// demo runs the real Codex backend and must be reported independently.
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "playwright";
import { createConversationEngine } from "../src/engine/conversation.mjs";
import { createStudioController } from "../src/adapters/browser/controller.mjs";
import { createHudStore } from "../src/runtime/hud-server.mjs";
import { createPreviewRelay } from "../src/runtime/preview-relay.mjs";
import { startStudioServer } from "../src/runtime/studio-server.mjs";

const servers = [];
const relay = createPreviewRelay();
const hudStore = createHudStore();
const executions = [];
const engine = await createConversationEngine({
  config: {
    voiceMode: "meeting",
    powerMode: true,
    allParticipantsOperate: true,
    observationIntervalMs: 600000,
  },
  logger: {},
  onEvent: (event) => hudStore.publish(event),
  output: { postText: async () => {} },
  execution: {
    observeMeeting: async () =>
      JSON.stringify({
        minutes: "",
        shouldReply: false,
        tasks: [],
        taskControls: [],
      }),
    runTask: async (task, { signal }) => {
      executions.push(task.id);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 350);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
      task.runRevision = (task.runRevision ?? 0) + 1;
      const revision = task.runRevision;
      const server = createServer((req, res) => {
        res
          .writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
          .end(
            `<!doctype html><html lang="ja"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ひらく展示</title><style>body{margin:0;padding:28px;font:16px system-ui;background:#f4f2e9;color:#183c2e}small{letter-spacing:.16em}h1{font-size:38px;line-height:1.25;margin:22px 0}p{line-height:1.8;color:#476050}button{padding:13px 20px;background:#215c43;color:white;border:0;border-radius:7px;font:inherit}article{background:white;border:1px solid #cbd7c9;border-radius:10px;padding:20px;margin:20px 0}article h2{font-size:19px;margin:0 0 8px}article p{font-size:13px;margin:0}</style><small>OPEN CAMPUS / EXHIBITION</small><h1>気になる展示へ、<br>まっすぐ。</h1><p>いま体験できる展示を見つけよう。</p><button onclick="this.textContent='体験できる展示を表示中';document.getElementById('pending').hidden=${revision < 2}">いま体験できる</button><article><h2>音で描くキャンバス</h2><p>声の高さで、光の線が変わる。</p></article><article><h2>手のひらの小さな街</h2><p>模型に触れて、街の未来をつくる。</p></article><article id="pending"><h2>準備中の展示</h2><p>${revision > 1 ? "下にまとめて表示しています" : "あと少しで体験できます"}</p></article></html>`,
          );
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      servers.push(server);
      task.preview = {
        state: "available",
        runRevision: revision,
        specRevision: task.activeSpecRevision ?? task.specRevision ?? 1,
        url: `http://127.0.0.1:${server.address().port}/`,
        confirmations: [],
        browserVerified: true,
        verification: "テスト用の操作記録",
        expiresAt: Date.now() + 3600000,
      };
      await relay.expose(task);
      return `実行 ${revision}: 展示案内を更新しました。`;
    },
    invalidatePreview: async (task) => {
      if (task.preview) task.preview.state = "superseded";
      await relay.expose(task);
    },
    confirmPreview: async (task, revision, userId) => {
      if (
        task.preview?.runRevision !== revision ||
        task.preview.state !== "available"
      )
        return false;
      if (
        !task.preview.confirmations.some(
          (confirmation) => confirmation.userId === userId,
        )
      )
        task.preview.confirmations.push({ userId, at: Date.now() });
      return true;
    },
  },
});
const controller = createStudioController({
  engine,
  hudStore,
  name: "展示をみんなでつくる",
});
const studio = await startStudioServer({
  port: 0,
  rooms: new Map([
    ["exhibition", { name: "展示をみんなでつくる", controller }],
    ["second", { name: "別プロジェクト", controller }],
  ]),
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.HUD_BROWSER_EXECUTABLE
    ? { executablePath: process.env.HUD_BROWSER_EXECUTABLE }
    : {}),
});
const output =
  process.env.IDD_STUDIO_SCREENSHOT_DIR ?? "/tmp/idd-studio-browser";
await mkdir(output, { recursive: true });
try {
  const errors = [];
  const first = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const second = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await first.newPage(),
    peer = await second.newPage();
  for (const surface of [page, peer])
    surface.on("pageerror", (error) => errors.push(error.message));
  await page.goto(studio.url);
  await page
    .getByRole("heading", { name: "チームのエンジンにつなぐ" })
    .waitFor();
  await page.screenshot({ path: `${output}/01-connect.png`, fullPage: true });
  await page.getByLabel("表示名", { exact: true }).fill("つくる人");
  await page
    .getByLabel("接続コード", { exact: true })
    .fill(studio.operatorCode);
  await page.getByRole("button", { name: "共有スタジオに入る" }).click();
  await page.getByText("エンジン接続中", { exact: true }).waitFor();
  await peer.goto(studio.invitation());
  await peer.getByLabel("表示名", { exact: true }).fill("試す人");
  await peer.getByRole("button", { name: "共有スタジオに入る" }).click();
  await peer.getByText("エンジン接続中", { exact: true }).waitFor();
  await page
    .getByLabel("会話への発言")
    .fill("スマートフォンで使える展示案内がほしい。ログインはいらない。");
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await peer
    .getByText("スマートフォンで使える展示案内がほしい。ログインはいらない。", {
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "新しくつくる", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("実現したいこと", { exact: true })
    .fill("ひらく展示の案内ページをつくる");
  await dialog
    .getByLabel("満たしたい条件", { exact: false })
    .fill("スマートフォンで使える\nログインなしで触れる");
  await dialog.getByRole("button", { name: "Codexにつくってもらう" }).click();
  await page
    .frameLocator("iframe")
    .getByRole("button", { name: "いま体験できる", exact: true })
    .waitFor();
  await peer
    .frameLocator("iframe")
    .getByRole("button", { name: "いま体験できる", exact: true })
    .click();
  await peer
    .getByRole("button", { name: "この版を試した", exact: true })
    .click();
  await page.getByText("1 接続が試しました", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "会話", exact: true }).click();
  await page.screenshot({ path: `${output}/02-shared.png`, fullPage: true });
  await peer
    .getByRole("button", { name: "ここを直したい", exact: true })
    .click();
  await peer
    .getByLabel("追加の指示", { exact: true })
    .fill("隠すのではなく、準備中の展示を下にまとめて。");
  await peer.getByRole("button", { name: "送信", exact: true }).click();
  await peer.getByText("仕様 2 / 実行 2", { exact: true }).waitFor();
  await page
    .frameLocator("iframe")
    .getByText("下にまとめて表示しています", { exact: true })
    .waitFor();
  assert.equal(engine.taskQueue.list().length, 1);
  assert.equal(executions.length, 2);
  await page.getByRole("tab", { name: "仕様", exact: true }).click();
  await page
    .getByText("隠すのではなく、準備中の展示を下にまとめて。", { exact: true })
    .waitFor();
  await page.screenshot({
    path: `${output}/03-correction.png`,
    fullPage: true,
  });
  // A draft keeps the version that was visible when editing started.
  await page
    .getByRole("button", { name: "ここを直したい", exact: true })
    .click();
  await page
    .getByLabel("追加の指示", { exact: true })
    .fill("古い画面からの修正");
  await peer
    .getByLabel("追加の指示", { exact: true })
    .fill("文字を少し大きくして");
  await peer.getByRole("button", { name: "送信", exact: true }).click();
  await page.getByText("仕様 3 / 実行 3", { exact: true }).waitFor();
  await page.getByRole("button", { name: "送信", exact: true }).click();
  await page
    .getByRole("alert")
    .getByText(
      "別の参加者が作業を更新しました。最新の内容を確認して再送してください。",
      { exact: true },
    )
    .waitFor();
  assert.equal(executions.length, 3);
  await page.getByRole("button", { name: "通知を閉じる", exact: true }).click();
  await page.getByLabel("追加の指示", { exact: true }).fill("");
  await page.getByRole("button", { name: "新しくつくる", exact: true }).click();
  await dialog
    .getByLabel("実現したいこと", { exact: true })
    .fill("展示の探し方を比較する");
  await dialog.getByLabel("二つの案を並行してつくる", { exact: true }).check();
  await dialog.getByLabel("案 A", { exact: true }).fill("一覧を中心に");
  await dialog.getByLabel("案 B", { exact: true }).fill("場所を中心に");
  await dialog.getByRole("button", { name: "二つの案をつくる" }).click();
  await page.locator("iframe").nth(1).waitFor();
  assert.equal(engine.taskQueue.list().length, 3);
  await page.screenshot({ path: `${output}/04-compare.png`, fullPage: true });
  await page.getByLabel("比較する成果", { exact: true }).selectOption("");
  let lostResponse = false;
  await page.route("**/commands", async (route) => {
    if (!lostResponse && route.request().method() === "POST") {
      lostResponse = true;
      await route.fetch();
      await route.abort("failed");
    } else await route.continue();
  });
  await page.getByRole("button", { name: "新しくつくる", exact: true }).click();
  await dialog
    .getByLabel("実現したいこと", { exact: true })
    .fill("通信復帰の確認");
  await dialog.getByRole("button", { name: "Codexにつくってもらう" }).click();
  await page.getByRole("alert").waitFor();
  await page.reload();
  await page
    .getByRole("button", { name: "同じ送信を再試行", exact: true })
    .click();
  await page.getByText("受け付けました。", { exact: true }).waitFor();
  assert.equal(
    engine.taskQueue.list().length,
    4,
    "lost response and page reload did not duplicate the task",
  );
  await page.unroute("**/commands");
  await page.getByRole("button", { name: "接続と共有", exact: true }).click();
  await page.getByLabel("操作用の共有リンク", { exact: true }).waitFor();
  await page.getByLabel("閲覧用の共有リンク", { exact: true }).waitFor();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "閉じる", exact: true })
    .click();
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    assert.equal(
      await page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
      true,
      `no horizontal overflow at ${width}`,
    );
    await page.screenshot({
      path: `${output}/05-width-${width}.png`,
      fullPage: true,
    });
  }
  await page.getByRole("button", { name: "発表画面", exact: true }).click();
  await page.screenshot({ path: `${output}/06-stage.png`, fullPage: true });
  await page.getByRole("button", { name: "通常画面", exact: true }).click();
  await first.setOffline(true);
  await page.getByText("再接続中", { exact: true }).waitFor();
  await first.setOffline(false);
  await page.getByText("エンジン接続中", { exact: true }).waitFor();
  await page.reload();
  await page.getByText("エンジン接続中", { exact: true }).waitFor();
  assert.equal(errors.length, 0, errors.join("\n"));
  console.log(
    JSON.stringify({
      passed: true,
      execution: "synthetic",
      clients: 2,
      tasks: engine.taskQueue.list().length,
      executions: executions.length,
      checks: [
        "shared conversation",
        "same-task correction",
        "revision conflict",
        "parallel alternatives",
        "preview confirmation",
        "responsive 320/768/1024/1440",
        "stage",
        "disconnect/recovery",
        "session reload",
      ],
      screenshots: output,
    }),
  );
} finally {
  await browser.close();
  await studio.close();
  await controller.close();
  await engine.session.stop();
  await engine.taskQueue.stop();
  await relay.close();
  await Promise.all(
    servers.map(
      (server) =>
        new Promise((resolve) => {
          server.close(resolve);
          server.closeAllConnections();
        }),
    ),
  );
}
