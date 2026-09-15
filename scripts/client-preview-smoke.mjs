import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { chromium } from "playwright";
import {
  previewFixture,
  until,
} from "../packages/client/test/preview-fixture.ts";

const fixture = await previewFixture();
const { client, artifacts } = fixture;
let browser;
try {
  const originalRequest = client.workspaceRequest;
  let meeting = {
    id: "m",
    projectId: "p",
    name: "検索画面の比較会議",
    summaryRevision: 0,
    messages: [],
    summary:
      "## 実装の確認\n\n[2案を比較](ido://projects/p/compare/a/b)\n\n[案Aを起動](ido://projects/p/previews/a)",
  };
  client.workspaceRequest = async (operation, input) => {
    if (operation === "project.snapshot")
      return {
        project: client.settings.projects[0],
        canEditMinutes: true,
        minutes: [meeting],
        tasks: artifacts.map((a) => ({
          ...a,
          id: a.taskId,
          text: a.title,
          state: "completed",
          history: [],
        })),
        participants: [],
      };
    if (operation === "project.minutes.update") {
      meeting = {
        ...meeting,
        summary: input.markdown,
        summaryRevision: meeting.summaryRevision + 1,
      };
      return meeting;
    }
    return originalRequest(operation, input);
  };
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1560, height: 1100 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(client.origin);
  await page
    .locator('.project-group[data-project-id="p"]')
    .getByRole("button", { name: "議事録", exact: true })
    .click();
  await page
    .locator(".minutes-list-row")
    .filter({ hasText: meeting.name })
    .click();
  await page.getByRole("link", { name: "2案を比較" }).click();
  const dialog = page.getByRole("dialog", { name: "2案を比較", exact: true });
  await page.getByText("起動できます", { exact: true }).first().waitFor();
  await dialog.getByRole("button", { name: "起動", exact: true }).click();
  await until(
    () =>
      [...client.localPreviews.entries.values()].filter(
        (e) => e.view.state === "running",
      ).length === 2,
    20_000,
  );
  await page.locator(".preview-pane iframe").nth(1).waitFor();
  await page
    .frameLocator(".preview-pane iframe")
    .first()
    .getByRole("button", { name: "試す" })
    .click();
  await page
    .frameLocator(".preview-pane iframe")
    .first()
    .getByRole("button", { name: "操作できました" })
    .waitFor();
  assert.equal(fixture.maxPlanning(), 1);
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/preview-live.png",
    fullPage: true,
  });
  await until(
    () =>
      [...client.localPreviews.entries.values()].every((e) => !!e.view.capture),
    30_000,
  );
  await dialog.getByText("画像比較", { exact: true }).click();
  await page.locator(".preview-capture").nth(1).waitFor();
  await page.screenshot({
    path: ".ido-build/screenshots/preview-images.png",
    fullPage: true,
  });
  await dialog.getByLabel("表示幅", { exact: true }).fill("640");
  await dialog.getByLabel("表示高さ", { exact: true }).fill("480");
  await dialog.getByLabel("対象パス", { exact: true }).fill("/settings");
  await dialog.getByRole("button", { name: "同じ条件で撮影" }).click();
  await until(
    () =>
      [...client.localPreviews.entries.values()].every(
        (e) => e.view.capture?.path === "/settings",
      ),
    30_000,
  );
  assert.ok(
    [...client.localPreviews.entries.values()].every(
      (e) => e.view.capture.width === 640,
    ),
  );
  await page.setViewportSize({ width: 600, height: 950 });
  await page.screenshot({
    path: ".ido-build/screenshots/preview-mobile.png",
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
  await page.setViewportSize({ width: 1560, height: 1100 });
  await dialog.getByText("操作して比較", { exact: true }).click();
  await dialog.getByLabel("対象パス", { exact: true }).fill("/blocked");
  await dialog.getByRole("button", { name: "パスを表示" }).click();
  await page
    .getByText(
      "このアプリは埋め込み表示を許可していません。画像比較または別タブで確認できます。",
    )
    .first()
    .waitFor();
  await page.keyboard.press("Escape");
  await until(() =>
    [...client.localPreviews.entries.values()].every(
      (e) => e.view.state === "stopped",
    ),
  );
  await page.setViewportSize({ width: 1560, height: 1100 });
  await page.getByRole("button", { name: "編集", exact: true }).click();
  await page.getByRole("button", { name: "起動・比較リンクを挿入" }).click();
  const picker = page.getByRole("dialog", { name: "起動・比較リンクを挿入" });
  await picker.getByLabel("実装済みタスク（2件まで）").click();
  await page
    .getByRole("option", { name: artifacts[0].title, exact: true })
    .click();
  await page
    .getByRole("option", { name: artifacts[1].title, exact: true })
    .click();
  await picker.getByLabel("実装済みタスク（2件まで）").press("Escape");
  await picker.getByRole("button", { name: "挿入", exact: true }).click();
  await page.getByRole("button", { name: "保存", exact: true }).click();
  assert.ok(meeting.summary.includes("ido://projects/p/compare/a/b"));
  assert.deepEqual(errors, []);
  console.log(
    "Preview smoke passed: minutes links, two worktrees, agent slots, live interaction, images, resize, mobile, editor, teardown.",
  );
} finally {
  await browser?.close();
  await fixture.close();
}
