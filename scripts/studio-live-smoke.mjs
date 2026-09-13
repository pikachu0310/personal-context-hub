import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

// Explicit, opt-in real Codex calls against the locally configured rehearsal
// projects. Invitations, browser tokens and raw conversation are never logged.
if (!process.env.IDD_STUDIO_LIVE_ACCESS)
  throw new Error("Set IDD_STUDIO_LIVE_ACCESS to the local access.json path");
const url = process.env.IDD_STUDIO_LIVE_URL ?? "http://127.0.0.1:4312/studio";
const access = JSON.parse(
  await readFile(process.env.IDD_STUDIO_LIVE_ACCESS, "utf8"),
);
const output =
  process.env.IDD_STUDIO_SCREENSHOT_DIR ?? "/tmp/idd-studio-live-evidence";
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.HUD_BROWSER_EXECUTABLE
    ? { executablePath: process.env.HUD_BROWSER_EXECUTABLE }
    : {}),
});
const evidence = {
  execution: "real Codex",
  clients: "two automated browser contexts",
  checks: [],
  timings: {},
};
try {
  const first = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const second = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await first.newPage(),
    peer = await second.newPage();
  page.setDefaultTimeout(600000);
  peer.setDefaultTimeout(600000);
  const login = async (surface, name) => {
    await surface.goto(url);
    await surface.getByLabel("表示名", { exact: true }).fill(name);
    await surface
      .getByLabel("接続コード", { exact: true })
      .fill(access.operatorCode);
    await surface.getByRole("button", { name: "共有スタジオに入る" }).click();
    await surface.getByText("エンジン接続中", { exact: true }).waitFor();
  };
  await login(page, "検証担当A");
  await login(peer, "検証担当B");
  const dialog = page.getByRole("dialog");
  const start = Date.now();
  if (!process.env.IDD_STUDIO_LIVE_RESUME) {
    await page
      .getByLabel("会話への発言", { exact: true })
      .fill(
        "来場者が、その場で体験できる展示を見つける案内がほしい。スマートフォンで、ログインなしで使いたい。",
      );
    await page.getByRole("button", { name: "送信", exact: true }).click();
    await page
      .getByRole("button", { name: "新しくつくる", exact: true })
      .click();
    await dialog
      .getByLabel("実現したいこと", { exact: true })
      .fill(
        "来場者向け『ひらく展示』案内ページを作って。booths.jsonの架空の5展示を使い、初期状態は全展示を表示。『いま体験できる』ボタンを押すとreadyの展示だけを表示し、preparingの展示は隠して。フィルター後の見出しは正確に『体験できる展示』とし、元に戻せる操作も用意して。明るい生成りの背景、深い緑、大きな日本語見出し、展示の場所と所要時間がすぐわかる、印象に残る上品なデザインにして。見た目だけでなく実際に操作できるものを。新たな依存や外部通信は不要。",
      );
    await dialog
      .getByLabel("満たしたい条件", { exact: false })
      .fill(
        "320pxでも横にはみ出さず、スマートフォンで使える\nログイン不要\n『いま体験できる』は幅120px以上・高さ44px以上\nreadyだけを表示でき、全5件にも戻せる",
      );
    await dialog.getByRole("button", { name: "Codexにつくってもらう" }).click();
    console.log("Live rehearsal: real Codex received the exhibition request.");
  } else {
    evidence.reusedInitialPreview = true;
    console.log(
      "Live rehearsal: continuing from the existing real Codex preview.",
    );
  }
  await page
    .frameLocator("iframe")
    .getByRole("button", { name: "いま体験できる", exact: true })
    .waitFor();
  await page.getByText("ブラウザ操作を自動確認済み", { exact: true }).waitFor();
  if (!process.env.IDD_STUDIO_LIVE_RESUME)
    evidence.timings.firstPreviewMs = Date.now() - start;
  const originalTitle = await page.locator(".artifact-heading h1").innerText();
  await peer
    .getByRole("button", { name: new RegExp(originalTitle.slice(0, 20)) })
    .first()
    .click();
  await peer
    .frameLocator("iframe")
    .getByRole("button", { name: "いま体験できる", exact: true })
    .click();
  await peer
    .frameLocator("iframe")
    .getByText("体験できる展示", { exact: true })
    .waitFor();
  assert.equal(
    await peer
      .frameLocator("iframe")
      .getByText("ポケットの宇宙", { exact: true })
      .isVisible(),
    false,
  );
  await peer
    .getByRole("button", { name: "この版を試した", exact: true })
    .click();
  await page.getByText("1 接続が試しました", { exact: true }).waitFor();
  await page.screenshot({
    path: `${output}/01-real-preview.png`,
    fullPage: true,
  });
  await peer.screenshot({
    path: `${output}/02-second-client.png`,
    fullPage: true,
  });
  evidence.checks.push(
    "real generation",
    "configured browser verification",
    "second client interaction and confirmation",
  );
  console.log(
    "Live rehearsal: first preview is interactive and the second client confirmed this revision.",
  );
  await peer
    .getByRole("button", { name: "ここを直したい", exact: true })
    .click();
  await peer
    .getByLabel("追加の指示", { exact: true })
    .fill(
      "訂正。『いま体験できる』を押したとき、準備中の展示を隠すのではなく、readyの展示を上に、preparingは『準備中の展示』という別の見出しを付けて下にまとめて。5件全部は見えるようにして。他の条件とデザインは維持して。上側の見出し『体験できる展示』も維持して。",
    );
  const correctionStart = Date.now();
  await peer.getByRole("button", { name: "送信", exact: true }).click();
  console.log(
    "Live rehearsal: the second client sent a correction to the same Codex task.",
  );
  await page.getByText("仕様 2 / 実行 2", { exact: true }).waitFor();
  await page.getByText("ブラウザ操作を自動確認済み", { exact: true }).waitFor();
  await page
    .frameLocator("iframe")
    .getByRole("button", { name: "いま体験できる", exact: true })
    .click();
  await page
    .frameLocator("iframe")
    .getByRole("heading", { name: "準備中の展示", exact: true })
    .waitFor();
  await page
    .frameLocator("iframe")
    .getByText("ポケットの宇宙", { exact: true })
    .waitFor();
  assert.equal(
    await page.locator(".artifact-heading h1").innerText(),
    originalTitle,
  );
  evidence.timings.correctionPreviewMs = Date.now() - correctionStart;
  evidence.checks.push(
    "same-task real correction",
    "current specification and run match",
    "preparing booths remain visible under their own heading",
  );
  await page.getByRole("tab", { name: "仕様", exact: true }).click();
  await page.screenshot({
    path: `${output}/03-real-correction.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "発表画面", exact: true }).click();
  await page.screenshot({
    path: `${output}/04-real-stage.png`,
    fullPage: true,
  });
  console.log(
    "Live rehearsal: the revised preview meets the corrected behavior.",
  );
  if (process.env.IDD_STUDIO_LIVE_SECOND_PROJECT === "true") {
    await page.getByRole("button", { name: "通常画面", exact: true }).click();
    await page
      .getByLabel("プロジェクト", { exact: true })
      .selectOption("checklist");
    await page
      .getByRole("button", { name: "新しくつくる", exact: true })
      .click();
    await dialog
      .getByLabel("実現したいこと", { exact: true })
      .fill(
        "チームの当日の準備チェックリストを作って。明るく落ち着いた見やすい日本語UIで、初期項目は『発表の練習』『スマートフォンで動作確認』『提出内容の確認』。チェック状態の切替、未完了だけ表示、入力欄から項目追加が本当にできるもの。追加ボタンの名前は『項目を追加』。localStorageで同じ端末の再読み込み後も残して。320pxでも使え、ボタンは44px以上。外部通信や新しい依存は不要。",
      );
    const secondStart = Date.now();
    await dialog.getByRole("button", { name: "Codexにつくってもらう" }).click();
    await page
      .frameLocator("iframe")
      .getByRole("button", { name: "項目を追加", exact: true })
      .waitFor();
    await page
      .getByText("ブラウザ操作を自動確認済み", { exact: true })
      .waitFor();
    evidence.timings.secondProjectPreviewMs = Date.now() - secondStart;
    evidence.checks.push(
      "second configured repository created a different working app",
    );
    await page.screenshot({
      path: `${output}/05-second-project.png`,
      fullPage: true,
    });
  }
  await writeFile(`${output}/summary.json`, JSON.stringify(evidence, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ passed: true, ...evidence }));
} finally {
  await browser.close();
}
