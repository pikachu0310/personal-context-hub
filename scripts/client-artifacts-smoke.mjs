// Real Client UI, synthetic generated HTML, no AI or external services.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Client } from "../packages/client/dist/index.js";
const root = await mkdtemp(join(tmpdir(), "ido-artifacts-ui-"));
const client = new Client(join(root, "client"));
let browser;
try {
  await writeFile(
    join(root, "index.html"),
    `<!doctype html><html lang="ja"><meta charset="utf-8"><style>body{font:20px sans-serif;padding:30px;background:#edf3f9}button{padding:15px;background:#1476ca;color:white;border:0}h1{font-size:30px}</style><h1>移動方式の試作</h1><button id="try">前へ</button><p id="count">移動 0 回</p><p id="boundary"></p><script>let n=0;document.querySelector('#try').onclick=()=>document.querySelector('#count').textContent='移動 '+(++n)+' 回';try{parent.document.body.dataset.compromised='yes'}catch{document.querySelector('#boundary').textContent='隔離されています'}</script></html>`,
  );
  await client.start(0);
  client.settings.projects = [
    { id: "project", name: "VRゲームの移動方式", remote: "" },
  ];
  client.executor.runs.run = {
    origin: "local",
    directory: root,
    state: "completed",
    result: "二つの移動方式を触って比較できる試作を作成しました。",
    task: {
      id: "task",
      runId: "run",
      revision: 1,
      specRevision: 1,
      state: "completed",
      projectId: "project",
      meetingId: "meeting",
      authorId: "user",
      requestId: "request",
      text: "移動方式を比べるモックを作って",
      network: false,
      history: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
  };
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.IDO_BROWSER_EXECUTABLE,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests = [];
  await page.route("**/api/continue", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      status: requests.length === 1 ? 409 : 200,
      contentType: "application/json",
      body:
        requests.length === 1
          ? JSON.stringify({ error: "LOCAL_SLOTS_FULL" })
          : JSON.stringify({ ok: true }),
    });
  });
  await page.goto(client.origin);
  await page.getByRole("button", { name: "試作を開く", exact: true }).click();
  const frame = page.frameLocator('iframe[title="試作: index.html"]');
  await frame.getByRole("button", { name: "前へ" }).click();
  await frame.getByText("移動 1 回", { exact: true }).waitFor();
  await frame.getByText("隔離されています", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => document.body.dataset.compromised),
    undefined,
  );
  await page
    .getByLabel("試作への感想・修正依頼")
    .fill("速すぎるので半分にして");
  await page.getByRole("button", { name: "このタスクに修正を依頼" }).click();
  await page.getByText(/入力は残しています/).waitFor();
  assert.equal(
    await page.getByLabel("試作への感想・修正依頼").inputValue(),
    "速すぎるので半分にして",
  );
  await page.getByRole("button", { name: "このタスクに修正を依頼" }).click();
  await page.getByText(/修正依頼を受け付けました/).waitFor();
  assert.equal(requests[1].runId, "run");
  assert.equal(requests[1].instruction, "速すぎるので半分にして");
  assert.equal(requests[1].requestKey, requests[0].requestKey);
  assert.equal(
    await page.getByLabel("試作への感想・修正依頼").inputValue(),
    "",
  );
  await writeFile(
    join(root, "index.html"),
    "<h1>速度を半分にしました</h1><button>前へ</button>",
  );
  await page.getByRole("button", { name: "最新版を読み込む" }).click();
  await frame.getByRole("heading", { name: "速度を半分にしました" }).waitFor();
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/client-artifacts-desktop.png",
  });
  for (const width of [320, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".ido-build/screenshots/client-artifacts-mobile.png",
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      interactive: true,
      parentIsolated: true,
      feedbackReturnedToSameTask: true,
      refresh: true,
      responsive: [320, 768, 1024, 1440],
      errors: 0,
    }),
  );
} finally {
  await browser?.close();
  await client.close();
  await rm(root, { recursive: true, force: true });
}
