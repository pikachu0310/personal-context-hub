/* global document, innerWidth */
// Synthetic messages only; exercises the production chat components and CSS.
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile, mkdir } from "node:fs/promises";
import { chromium } from "playwright";

const { outputFiles } = await build({
  stdin: {
    contents: `import React from "react";
      import { createRoot } from "react-dom/client";
      import { RequestMessage, ActivityItem } from "./packages/client/src/ui/ActivityFeed.tsx";
      import { showStart } from "./packages/client/src/ui/chat-presentation.ts";
      const at = new Date("2026-01-01T12:00:00Z").getTime();
      const starts = [59,60,61].map(seconds => ({id: seconds + ":start", revision: 1, kind: "status", title: "作業を開始", text: "実行 1", at: at + seconds * 1000, updatedAt: at}));
      createRoot(document.getElementById("root")).render(<div className="conversation-content">
        <RequestMessage text="ディレクトリ一覧を教えて" sender={{id:"me",name:"自分"}} sentAt={at} status="accepted" />
        <RequestMessage text="関連する実装も確認してください" sender={{id:"idobot",name:"IDObot",bot:true}} sentAt={at+1000} />
        <RequestMessage text={"他の参加者からの追加指示です。".repeat(18)} sender={{id:"other",name:"別の参加者"}} sentAt={at+2000} />
        <RequestMessage text="旧ログの送信元は不明です" status="uncertain" />
        {starts.filter(entry => showStart(entry,at,starts)).map(entry => <ActivityItem key={entry.id} entry={entry} />)}
        <ActivityItem entry={{id:"reply",revision:1,kind:"message",title:"結果",text:"確認しました。",at,updatedAt:at}} />
        <ActivityItem entry={{id:"done",revision:1,kind:"status",title:"作業が完了しました",status:"completed",at:at+120000,updatedAt:at}} />
      </div>);`,
    resolveDir: process.cwd(),
    loader: "tsx",
  },
  bundle: true,
  write: false,
  format: "iife",
  jsx: "automatic",
});
const css = await readFile("packages/client/src/ui/workspace.css", "utf8");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({
    locale: "ja-JP",
    timezoneId: "Asia/Tokyo",
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setContent(
    '<html><head></head><body><div id="root"></div></body></html>',
  );
  await page.addStyleTag({
    content: `body { margin:0; font-family: sans-serif; --workspace-muted:#677080; --workspace-soft:#f3f4f6; --workspace-border:#ddd; } ${css}`,
  });
  await page.addScriptTag({ content: outputFiles[0].text });
  await page.locator(".request-message").first().waitFor();
  assert.equal(await page.locator(".request-message").count(), 4);
  assert.equal(await page.locator(".request-meta time").count(), 3);
  assert.equal(
    await page
      .locator(".timeline-status")
      .filter({ hasText: "作業を開始" })
      .count(),
    2,
  );
  assert.equal(await page.locator(".agent-message time").count(), 0);
  assert.equal(
    await page.getByRole("img", { name: "別の参加者", exact: true }).count(),
    1,
  );
  assert.equal(
    await page.getByRole("img", { name: "発言者不明", exact: true }).count(),
    1,
  );
  assert.match(await page.locator("body").innerText(), /配送確認が必要/);
  assert.doesNotMatch(
    await page.locator("body").innerText(),
    /あなた・追加指示|反映済み|実行 1|IDO Agent|プロジェクトへの依頼/,
  );
  await mkdir(".ido-build/screenshots", { recursive: true });
  for (const width of [1000, 375]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const row of await page.locator(".request-message").all()) {
      const bubble = await row.locator(".user-message").boundingBox();
      const avatar = await row.locator(".request-avatar").boundingBox();
      assert.ok(avatar.x >= bubble.x + bubble.width);
      const time = row.locator("time");
      if (await time.count())
        assert.ok((await time.boundingBox()).y >= bubble.y + bubble.height);
    }
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.screenshot({
      path: `.ido-build/screenshots/client-chat-${width}.png`,
      fullPage: true,
    });
  }
  assert.deepEqual(errors, []);
  console.log(
    "Chat smoke passed: attribution, compact labels, timing, desktop and narrow layout.",
  );
} finally {
  await browser.close();
}
