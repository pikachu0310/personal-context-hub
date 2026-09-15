import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Client } from "../packages/client/dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "ido-minutes-ui-"));
const client = new Client(join(directory, "client"));
client.credentials.backend = "file";
client.checkAccount = async () => {};
const projects = [
  { id: "p", name: "プロダクト開発", remote: "" },
  { id: "other", name: "デザイン", remote: "" },
];
const tasks = [
  {
    id: "task-one",
    runId: "run-one",
    updatedAt: 1789434000000,
    projectId: "p",
    title: "検索画面を実装",
    text: "検索画面の実装",
    state: "completed",
    revision: 1,
    result: "完了",
    history: [],
  },
  {
    id: "task-two",
    runId: "run-two",
    updatedAt: 1789434000001,
    projectId: "other",
    title: "デザインの確認",
    text: "画面構成を確認",
    state: "completed",
    revision: 1,
    result: "確認済み",
    history: [],
  },
];
const original =
  `## 決定事項\n\n検索はプロジェクト単位で絞り込み、**キーボード操作**に対応します。\n\n- [x] 要件の確認\n- [ ] [検索画面を実装](ido://projects/p/tasks/task-one)\n- [ ] [デザインの確認](ido://projects/other/tasks/task-two)\n\n### 次回までに\n\n| 担当 | 確認すること |\n| --- | --- |\n| 開発 | 検索結果と空状態 |\n| デザイン | 余白とフォーカス表示 |\n\n> 未確定：モバイルの結果表示件数\n\n\`\`\`ts\nconst scope = "project";\n\`\`\`\n\n[参考資料](https://example.com) · ![参考画像](https://example.com/image.png)\n\n[削除済み](ido://projects/p/tasks/deleted) · [不正](javascript:alert%281%29)\n\n<script>window.hacked = true</script>` +
  "\n\n" +
  Array.from(
    { length: 18 },
    (_, index) =>
      `確認メモ ${index + 1}：本文を読みながら、議題の決定事項と元の発言を照合します。操作の根拠は発言ログで確認します。`,
  ).join("\n\n");
let meeting = {
  id: "meeting",
  projectId: "p",
  name: "検索体験の改善ミーティング",
  startedAt: 1789434000000,
  summary: original,
  summaryRevision: 0,
  messages: Array.from({ length: 120 }, (_, index) => ({
    id: `message-${index}`,
    authorId: `speaker-${index % 2}`,
    authorName: index % 2 ? "デザイン担当" : "開発担当",
    text:
      index === 0
        ? "限定検索語：初回の対象範囲の確認"
        : `発言${index}：検索体験について確認します。`,
    at: 1789434000000 + index * 1000,
    stage: "completed",
  })),
  knowledge: {
    revision: 1,
    updatedAt: 1789434000000,
    topics: Array.from({ length: 16 }, (_, index) => ({
      id: `topic-${index}`,
      title:
        ["検索の対象範囲", "キーボード操作", "モバイル表示"][index] ??
        `確認事項 ${index + 1}`,
      summary:
        index === 0
          ? "プロジェクト単位で検索する範囲を確認しました。"
          : "選択した議題の内容を確認します。",
      decisions:
        index === 1
          ? Array.from(
              { length: 30 },
              (_, n) => `決定 ${n + 1}：操作の一貫性を保ちます。`,
            )
          : ["プロジェクト単位で検索する"],
      openQuestions: ["モバイルでの表示件数は次回確認する"],
      sourceIds: [`message-${index}`, `message-${index + 1}`],
      updatedAt: 1789434000000 + index * 1000,
    })),
  },
};
const older = {
  ...meeting,
  id: "older",
  name: "前回の議事録",
  startedAt: meeting.startedAt - 60000,
  summary: "## 前回の決定",
  closedAt: meeting.startedAt - 30000,
};
const newer = {
  ...meeting,
  id: "newer",
  name: "最新の議事録",
  startedAt: meeting.startedAt + 60000,
  summary: "## 最新の決定",
};
const empty = { ...meeting, id: "empty", name: "空の議事録", summary: "" };
const whitespace = {
  ...meeting,
  id: "whitespace",
  name: "空白だけの議事録",
  summary: " \n\t　",
};
let canEdit = true,
  failSave = false;
client.workspaceRequest = async (operation, input) => {
  if (operation === "project.snapshot") {
    const project = projects.find((p) => p.id === input.projectId);
    if (!project) throw new Error("PROJECT_INVITATION_REQUIRED");
    return structuredClone({
      project,
      canEditMinutes: canEdit,
      minutes:
        project.id === "p" ? [older, empty, meeting, whitespace, newer] : [],
      tasks: tasks.filter((t) => t.projectId === project.id),
      participants: [],
    });
  }
  if (operation === "project.minutes.update") {
    if (failSave) throw new Error("REQUEST_FAILED");
    if (!canEdit) throw new Error("PERMISSION_DENIED");
    if (input.expectedRevision !== meeting.summaryRevision)
      throw new Error("MINUTES_CONFLICT");
    meeting = {
      ...meeting,
      summary: input.markdown,
      summaryRevision: meeting.summaryRevision + 1,
      summaryUpdatedAt: Date.now(),
    };
    return structuredClone(meeting);
  }
  throw new Error("UNKNOWN_OPERATION");
};
let browser;
try {
  await client.start(0);
  client.settings.projects = projects;
  client.settings.deviceId = "fixture-device";
  client.connected = true;
  client.projectTasks = tasks;
  for (const project of projects) client.allowedProjects.add(project.id);
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.IDO_BROWSER_EXECUTABLE,
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1050 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(client.origin);
  const minutes = () =>
    page
      .locator('.project-group[data-project-id="p"]')
      .getByRole("button", { name: "議事録", exact: true });
  const openMinutes = async () => {
    await minutes().click();
    await page
      .locator(".minutes-list-row")
      .filter({ hasText: meeting.name })
      .click();
  };
  await minutes().click();
  const rows = page.locator(".minutes-list-row");
  await rows.first().waitFor();
  assert.deepEqual(
    await page.locator(".minutes-list-title").allTextContents(),
    [newer.name, meeting.name, older.name],
  );
  assert.equal(await page.locator(".minutes-document").count(), 0);
  assert.ok((await rows.first().boundingBox()).height <= 44);
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/minutes-list.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "サイドバーを閉じる", exact: true })
    .click();
  await page.setViewportSize({ width: 600, height: 900 });
  assert.ok((await rows.first().boundingBox()).height <= 64);
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: ".ido-build/screenshots/minutes-list-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page
    .getByRole("button", { name: "サイドバーの表示を切り替える", exact: true })
    .click();
  await rows.filter({ hasText: newer.name }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("heading", { name: "最新の決定", exact: true })
    .waitFor();
  assert.equal(await page.locator(".minutes-document").count(), 1);
  await page.getByRole("button", { name: "← 議事録一覧に戻る" }).click();
  await openMinutes();
  await page.getByRole("heading", { name: "決定事項", exact: true }).waitFor();
  assert.equal(await page.locator(".minutes-markdown table").count(), 1);
  const documentPane = page.locator(".minutes-reader");
  const inspector = page.getByRole("region", { name: "議事録の関連情報" });
  await inspector.getByRole("button", { name: /キーボード操作/ }).click();
  await documentPane.evaluate((element) => {
    element.scrollTop = 220;
  });
  await page.screenshot({
    path: ".ido-build/screenshots/minutes-inspector-before.png",
    fullPage: true,
  });
  const documentPosition = await documentPane.evaluate((element) => ({
    top: element.getBoundingClientRect().top,
    height: element.clientHeight,
    scroll: element.scrollTop,
  }));
  assert.ok(documentPosition.scroll > 0);
  const detailPane = inspector.getByLabel("選択した議題の詳細", {
    exact: true,
  });
  await detailPane.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  assert.ok(await detailPane.evaluate((element) => element.scrollTop > 0));
  await inspector
    .getByRole("button", { name: "元の発言を見る（2件）" })
    .click();
  await inspector.getByRole("tabpanel", { name: "発言ログ" }).waitFor();
  assert.equal(await inspector.locator(".minutes-statement").count(), 2);
  assert.deepEqual(
    await documentPane.evaluate((element) => ({
      top: element.getBoundingClientRect().top,
      height: element.clientHeight,
      scroll: element.scrollTop,
    })),
    documentPosition,
  );
  await inspector.getByRole("button", { name: "← 議題に戻る" }).click();
  assert.equal(
    await inspector
      .getByRole("button", { name: /キーボード操作/ })
      .getAttribute("aria-pressed"),
    "true",
  );
  await inspector.getByRole("tab", { name: "発言ログ", exact: true }).click();
  await inspector
    .getByRole("button", { name: "すべての発言", exact: true })
    .click();
  assert.equal(await inspector.locator(".minutes-statement").count(), 100);
  await inspector
    .getByRole("button", { name: "以前の発言をさらに表示" })
    .click();
  assert.equal(await inspector.locator(".minutes-statement").count(), 120);
  const search = inspector.getByRole("textbox", { name: "議題・発言を検索" });
  await search.fill("限定検索語");
  assert.equal(await inspector.locator(".minutes-statement").count(), 1);
  await search.fill("存在しないキーワード");
  await inspector
    .getByText("一致する発言はありません。", { exact: true })
    .waitFor();
  await search.fill("");
  await inspector.getByRole("tab", { name: "議題", exact: true }).click();
  await search.fill("検索の対象範囲");
  assert.equal(
    await inspector.locator(".minutes-topic-index button").count(),
    1,
  );
  await search.fill("");
  await inspector.getByRole("button", { name: /検索の対象範囲/ }).click();
  await documentPane.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.screenshot({
    path: ".ido-build/screenshots/minutes-inspector-desktop.png",
    fullPage: true,
  });
  // A compact viewport swaps visible panes without unmounting the document/editor.
  await page
    .getByRole("button", { name: "サイドバーを閉じる", exact: true })
    .click();
  await page.setViewportSize({ width: 600, height: 900 });
  await documentPane.evaluate((element) => {
    element.scrollTop = 180;
  });
  const mobileScroll = await documentPane.evaluate(
    (element) => element.scrollTop,
  );
  await page.getByRole("button", { name: "詳細・発言", exact: true }).click();
  assert.equal(await documentPane.isVisible(), false);
  assert.equal(await inspector.isVisible(), true);
  assert.equal(
    await page.evaluate(
      () =>
        globalThis.document.documentElement.scrollWidth <=
        globalThis.innerWidth,
    ),
    true,
  );
  await page.screenshot({
    path: ".ido-build/screenshots/minutes-inspector-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "本文", exact: true }).click();
  assert.equal(
    await documentPane.evaluate((element) => element.scrollTop),
    mobileScroll,
  );
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page
    .getByRole("button", { name: "サイドバーの表示を切り替える", exact: true })
    .click();
  await page
    .getByRole("button", { name: "プロジェクト詳細", exact: true })
    .click();
  await page.getByRole("dialog", { name: "プロジェクト詳細" }).waitFor();
  await page.keyboard.press("Escape");
  await page
    .getByRole("dialog", { name: "プロジェクト詳細" })
    .waitFor({ state: "hidden" });

  assert.equal(
    await page
      .locator(".minutes-markdown img, .minutes-markdown script")
      .count(),
    0,
  );
  assert.equal(
    await page.getByRole("link", { name: "不正", exact: true }).count(),
    0,
  );
  assert.equal(await page.evaluate(() => globalThis.hacked), undefined);
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/minutes-reading.png",
    fullPage: true,
  });
  await page.getByRole("link", { name: "削除済み" }).click();
  await page.getByRole("alert").filter({ hasText: "タスクは削除" }).waitFor();
  await page.getByRole("link", { name: "デザインの確認" }).click();
  await page
    .getByRole("heading", { name: "デザインの確認", exact: true })
    .waitFor();
  assert.equal(
    await page
      .locator('.project-group[data-project-id="other"] .task-link.selected')
      .count(),
    1,
  );
  await openMinutes();
  await page.getByRole("link", { name: "検索画面を実装" }).focus();
  await page.keyboard.press("Enter");
  await page
    .getByRole("heading", { name: "検索画面を実装", exact: true })
    .waitFor();
  await openMinutes();
  await page.getByRole("button", { name: "編集", exact: true }).click();
  const editor = page.getByRole("textbox", { name: "議事録のMarkdown" });
  const readSource = async () => {
    await editor.press("ControlOrMeta+a");
    // The editor virtualizes offscreen lines. Read its normal copy output,
    // using an isolated event payload rather than the system clipboard.
    const value = await editor.evaluate((element) => {
      const data = new globalThis.DataTransfer();
      element.dispatchEvent(
        new globalThis.ClipboardEvent("copy", {
          clipboardData: data,
          bubbles: true,
          cancelable: true,
        }),
      );
      return data.getData("text/plain");
    });
    await editor.press("ArrowRight");
    return value;
  };
  const replaceSource = async (text) => {
    await editor.press("ControlOrMeta+a");
    await page.keyboard.insertText(text);
  };
  await page
    .locator(".cm-md-source")
    .filter({ hasText: "## 決定事項" })
    .waitFor();
  assert.equal(await page.locator(".cm-md-source").count(), 1);
  assert.equal(await page.locator(".cm-md-table-row").count(), 3);
  await editor
    .locator(".cm-line")
    .filter({ hasText: "検索はプロジェクト単位" })
    .click();
  assert.match(
    await page.locator(".cm-md-source").innerText(),
    /\*\*キーボード操作\*\*/,
  );
  assert.equal(await page.locator(".cm-md-h2").innerText(), "決定事項");
  await editor.press("End");
  await page.keyboard.insertText(" 追記");
  assert.match(await readSource(), /追記/);
  await editor.press("ControlOrMeta+z");
  assert.equal(await readSource(), original);
  await editor.press(
    process.platform === "win32" ? "Control+y" : "ControlOrMeta+Shift+z",
  );
  assert.match(await readSource(), /追記/);
  await editor.press("ControlOrMeta+z");
  assert.equal(await readSource(), original);
  await replaceSource("前半\n後半");
  await editor.press("Home");
  await editor.press("Backspace");
  assert.equal(await readSource(), "前半後半");
  await editor.press("Home");
  await editor.press("Enter");
  assert.equal(await readSource(), "\n前半後半");
  await replaceSource("## 手動で整理\n\n- 最初の決定\n\n");
  await editor.dispatchEvent("compositionstart", { data: "" });
  await page.keyboard.insertText("日本語入力");
  await editor.dispatchEvent("compositionend", { data: "日本語入力" });
  assert.match(await readSource(), /日本語入力/);
  await editor.press("Enter");
  await page.getByRole("button", { name: "タスクリンクを挿入" }).click();
  await page
    .getByRole("combobox", { name: "プロジェクト", exact: true })
    .click();
  await page.getByRole("option", { name: "デザイン", exact: true }).click();
  await page.getByRole("combobox", { name: "タスク", exact: true }).click();
  await page
    .getByRole("option", { name: "デザインの確認", exact: true })
    .click();
  await page.getByRole("button", { name: "挿入", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.match(await readSource(), /ido:\/\/projects\/other\/tasks\/task-two/);
  const draft = await readSource();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "← 議事録一覧に戻る" }).click();
  assert.equal(await readSource(), draft);

  await editor.locator(".cm-line").filter({ hasText: "最初の決定" }).click();
  assert.equal(await page.locator(".cm-md-source").count(), 1);
  assert.equal(
    await page.locator(".minutes-editor-grid, .minutes-mobile-tabs").count(),
    0,
  );
  await page.screenshot({
    path: ".ido-build/screenshots/minutes-editing.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "サイドバーを閉じる", exact: true })
    .click();
  await page.setViewportSize({ width: 600, height: 900 });
  assert.equal(await editor.isVisible(), true);
  await page.getByRole("button", { name: "詳細・発言", exact: true }).click();
  assert.equal(await editor.isVisible(), false);
  await page.getByRole("button", { name: "本文", exact: true }).click();
  assert.equal(await readSource(), draft);
  await editor.locator(".cm-line").filter({ hasText: "最初の決定" }).click();
  assert.equal(await page.locator(".cm-md-source").count(), 1);
  assert.equal(await page.locator(".cm-md-h2").innerText(), "手動で整理");
  await page.screenshot({
    path: ".ido-build/screenshots/minutes-mobile.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page
    .getByRole("button", { name: "サイドバーの表示を切り替える", exact: true })
    .click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page
    .locator('.project-group[data-project-id="other"]')
    .getByRole("button", { name: "議事録", exact: true })
    .click();
  assert.equal(await readSource(), draft);
  meeting = {
    ...meeting,
    summary: "## 別の編集者の最新版",
    summaryRevision: 1,
  };
  await page.waitForResponse((r) => r.url().endsWith("/api/project/snapshot"));
  assert.equal(await readSource(), draft);
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("最新版を確認してください", { exact: true }).waitFor();
  assert.equal(await readSource(), draft);
  await page
    .getByRole("button", { name: "最新版を確認しました・編集を続ける" })
    .click();
  client.connected = false;
  await page.waitForFunction(
    () =>
      globalThis.document
        .querySelector('[aria-label="議事録のMarkdown"]')
        ?.getAttribute("contenteditable") === "false",
  );
  assert.equal(await editor.isVisible(), true);
  client.connected = true;
  await page.waitForFunction(
    () =>
      globalThis.document
        .querySelector('[aria-label="議事録のMarkdown"]')
        ?.getAttribute("contenteditable") === "true",
  );
  failSave = true;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "REQUEST_FAILED" }).waitFor();
  assert.equal(await readSource(), draft);
  failSave = false;
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await editor.waitFor({ state: "detached" });
  assert.equal(meeting.summary, draft);
  await page.reload();
  await openMinutes();
  await page
    .getByRole("heading", { name: "手動で整理", exact: true })
    .waitFor();
  canEdit = false;
  await page.waitForResponse((r) => r.url().endsWith("/api/project/snapshot"));
  await page
    .getByRole("button", { name: "編集", exact: true })
    .waitFor({ state: "detached" });
  canEdit = true;
  await page.getByRole("button", { name: "編集", exact: true }).waitFor();
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await replaceSource(" \n　");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.locator(".minutes-list-row").first().waitFor();
  assert.deepEqual(
    await page.locator(".minutes-list-title").allTextContents(),
    [newer.name, older.name],
  );
  await page
    .locator('.project-group[data-project-id="other"]')
    .getByRole("button", { name: "議事録", exact: true })
    .click();
  await page
    .getByText("本文のある議事録はまだありません。", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator(".minutes-list-row, .minutes-document").count(),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    "Client minutes browser smoke passed: fixed detail inspector, topic selection, cited sources, log search and pagination, independent scrolling, mobile pane preservation, compact newest-first list, empty filtering, detail navigation, draft protection, single-pane live preview, active source line, undo/redo, line breaks, Japanese input, links, mobile, conflicts, failures, persistence, readonly.",
  );
} finally {
  await browser?.close();
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
