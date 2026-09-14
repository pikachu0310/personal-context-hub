// Real Client UI with synthetic project data; no external services.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Client } from "../packages/client/dist/index.js";
const directory = await mkdtemp(join(tmpdir(), "ido-meeting-ui-"));
const client = new Client(directory);
client.credentials.backend = "file";
client.checkAccount = async () => {};
const now = Date.now();
const project = { id: "project", name: "検索画面の検討", remote: "" };
const messages = [
  {
    id: "a",
    authorId: "alice",
    authorName: "参加者A",
    at: now - 60000,
    text: "検索画面は一覧から条件で絞り込む方式がいいと思う。",
    role: "user",
  },
  {
    id: "b",
    authorId: "bob",
    authorName: "参加者B",
    at: now - 30000,
    text: "一覧からの絞り込みで決定しよう。検索速度は金曜日に測ろう。",
    role: "user",
  },
  {
    id: "c",
    authorId: "alice",
    authorName: "参加者A",
    at: now,
    text: "モックは青を基調にしたい。",
    role: "user",
  },
];
const minutes = [
  {
    id: "meeting",
    name: "今日の打ち合わせ",
    projectId: "project",
    startedAt: now - 600000,
    summary: "# 編集済み議事録\n\n手動で追記した検討事項。",
    messages,
    knowledge: {
      revision: 1,
      updatedAt: now,
      topics: [
        {
          id: "topic",
          title: "検索画面の絞り込み方式",
          summary:
            "検索画面は一覧から条件で絞り込む方式に決定した。検索速度の計測は金曜日に行う。",
          decisions: [
            "一覧から条件で絞り込む方式を採用する",
            "金曜日に検索速度を計測する",
          ],
          openQuestions: ["検索速度の計測結果"],
          sourceIds: ["a", "b"],
          updatedAt: now,
        },
      ],
    },
  },
];
let browser;
try {
  await client.start(0);
  client.settings.projects = [project];
  client.connected = true;
  client.allowedProjects.add("project");
  client.settings.deviceId = "device";
  client.workspaceRequest = async (operation) => {
    assert.equal(operation, "project.snapshot");
    return { project, minutes, tasks: [], participants: [] };
  };
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.IDO_BROWSER_EXECUTABLE,
  });
  const page = await browser.newPage({
    viewport: { width: 1360, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.goto(client.origin);
  await page.getByRole("button", { name: "議事録", exact: true }).click();
  await page.getByRole("heading", { name: "編集済み議事録" }).waitFor();
  await page.getByText("議題・元の発言を確認", { exact: true }).click();
  await page.getByRole("heading", { name: "検索画面の絞り込み方式" }).waitFor();
  await page.getByText("更新中", { exact: true }).waitFor();
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/meeting-minutes-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "元の発言を見る（2件）" }).click();
  assert.equal(await page.locator("#statement-a").count(), 1);
  assert.equal(await page.locator("#statement-b").count(), 1);
  assert.equal(await page.locator("#statement-c").count(), 0);
  await page.getByRole("button", { name: "すべての発言へ戻る" }).click();
  await page.getByLabel("議事録・発言を検索").fill("青");
  assert.equal(await page.locator("#statement-c").count(), 1);
  assert.equal(await page.locator("#statement-a").count(), 0);
  await page.screenshot({
    path: ".ido-build/screenshots/meeting-source-search.png",
    fullPage: true,
  });
  await page.getByLabel("議事録・発言を検索").fill("");
  await page.getByRole("tab", { name: "議題別の議事録" }).click();
  await page
    .getByRole("button", { name: "サイドバーを閉じる", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".agent-workspace.sidebar-hidden").waitFor();
  await page.screenshot({
    path: ".ido-build/screenshots/meeting-minutes-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      currentMinutes: true,
      citationNavigation: true,
      rawSearch: true,
      mobileOverflow: false,
      browserErrors: 0,
    }),
  );
} finally {
  await browser?.close();
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
