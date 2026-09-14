// Real Client UI with synthetic project data; no external services.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Client } from "../packages/client/dist/index.js";
const directory = await mkdtemp(join(tmpdir(), "ido-meeting-ui-"));
const client = new Client(directory);
const now = Date.now();
const project = { id: "project", name: "検索画面の検討", remote: "" };
const messages = [
  ...Array.from({ length: 220 }, (_, index) => ({
    id: `older-${index}`,
    authorId: "alice",
    authorName: "参加者A",
    at: now - 900000 - index * 1000,
    text: index === 219 ? "最初の議論で決めた追加仕様" : `過去の発言 ${index}`,
    role: "user",
  })),
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
    summary: "",
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
  client.workspaceRequest = async (operation, input) => {
    if (operation === "project.transcript") {
      assert.equal(input.projectId, "project");
      const selected = messages
        .filter(
          (m) =>
            (!input.topicId || ["a", "b"].includes(m.id)) &&
            (!input.query || m.text.includes(input.query)),
        )
        .toSorted((a, b) => b.at - a.at);
      if (input.topicId) assert.equal(input.meetingId, "meeting");
      const older = selected.filter(
        (m) => !input.before || m.at < input.before.at,
      );
      const page = older
        .slice(0, 100)
        .map((m) => ({
          ...m,
          meetingId: "meeting",
          meetingName: "今日の打ち合わせ",
        }));
      const last = page.at(-1);
      return {
        messages: page,
        total: selected.length,
        ...(older.length > page.length
          ? { next: { id: last.id, at: last.at } }
          : {}),
      };
    }
    assert.equal(operation, "project.snapshot");
    return {
      project,
      transcriptPaging: true,
      minutes: minutes.map((m) => ({
        ...m,
        messageCount: messages.length,
        messages: messages.slice(-3),
      })),
      tasks: [],
      participants: [],
    };
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
  await page.getByRole("heading", { name: "検索画面の絞り込み方式" }).waitFor();
  await page.getByText("更新中", { exact: true }).waitFor();
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/meeting-minutes-desktop.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "元の発言を見る（2件）" }).click();
  await page.locator("#statement-a").waitFor();
  assert.equal(await page.locator("#statement-a").count(), 1);
  assert.equal(await page.locator("#statement-b").count(), 1);
  assert.equal(await page.locator("#statement-c").count(), 0);
  await page.getByRole("button", { name: "すべての発言へ戻る" }).click();
  await page.getByLabel("議事録・発言を検索").fill("青");
  await page.getByText("1件の発言", { exact: false }).waitFor();
  await page.locator("#statement-c").waitFor();
  assert.equal(await page.locator("#statement-c").count(), 1);
  assert.equal(await page.locator("#statement-a").count(), 0);
  await page.screenshot({
    path: ".ido-build/screenshots/meeting-source-search.png",
    fullPage: true,
  });
  await page.getByLabel("議事録・発言を検索").fill("");
  await page.getByRole("button", { name: "以前の発言をさらに表示" }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('[id^="statement-"]').length === 200,
  );
  await page.getByLabel("議事録・発言を検索").fill("追加仕様");
  await page.locator("#statement-older-219").waitFor();
  assert.equal(await page.locator('[id^="statement-"]').count(), 1);
  await page.getByLabel("議事録・発言を検索").fill("");
  await page.getByRole("tab", { name: "議題別の議事録" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "議事録", exact: true }).click();
  await page.locator(".agent-workspace.sidebar-hidden").waitFor();
  await page.screenshot({
    path: ".ido-build/screenshots/meeting-minutes-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      currentMinutes: true,
      citationNavigation: true,
      rawSearch: true,
      historicalSearchAndPaging: true,
      mobileOverflow: false,
      browserErrors: 0,
    }),
  );
} finally {
  await browser?.close();
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
