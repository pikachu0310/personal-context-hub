import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

if (!process.env.IDD_STUDIO_LIVE_ACCESS)
  throw new Error("Set IDD_STUDIO_LIVE_ACCESS to the local access.json path");
const origin = new URL(
  process.env.IDD_STUDIO_LIVE_URL ?? "http://127.0.0.1:4312/studio",
).origin;
const access = JSON.parse(
  await readFile(process.env.IDD_STUDIO_LIVE_ACCESS, "utf8"),
);
const output =
  process.env.IDD_STUDIO_SCREENSHOT_DIR ?? "/tmp/idd-studio-live-evidence";
await mkdir(output, { recursive: true });
let token;
const api = async (path, input) => {
  const response = await fetch(origin + path, {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(input ? { method: "POST", body: JSON.stringify(input) } : {}),
  });
  const data = await response.json();
  assert.equal(response.status, 200, data.error);
  return data;
};
token = (
  await api("/api/studio/login", {
    code: access.operatorCode,
    name: "比較の検証",
  })
).token;
const snapshotPath = "/api/studio/rooms/exhibition/snapshot";
let snapshot = await api(snapshotPath);
const original = snapshot.tasks.find((task) => task.runRevision === 2);
assert.ok(original, "A real completed exhibition task is required");
await api("/api/studio/rooms/exhibition/commands", {
  type: "preview",
  id: crypto.randomUUID(),
  meetingId: snapshot.meetingId,
  taskId: original.id,
  runRevision: original.runRevision,
  specRevision: original.specRevision,
  controlVersion: original.controlVersion,
});
snapshot = await api(snapshotPath);
assert.equal(
  snapshot.tasks.find((task) => task.id === original.id).preview.state,
  "available",
);
console.log(
  "Real rehearsal: reopening the completed preview after service restart passed.",
);
const started = Date.now();
const resumeIds = process.env.IDD_STUDIO_VARIANT_TASKS?.split(",");
const accepted = resumeIds
  ? { taskIds: resumeIds }
  : await api("/api/studio/rooms/exhibition/commands", {
      id: crypto.randomUUID(),
      meetingId: snapshot.meetingId,
      type: "variants",
      title: "展示案内の見せ方",
      text: "booths.jsonの5件を使い、展示案内の別案を比較したい。index.htmlだけで動く小さな実装にして、依存を追加しない。全展示を表示し、『いま体験できる』ボタンを押すとreadyの展示を上、preparingは下へ分け、上の見出しを『体験できる展示』にする。このボタンは幅120px以上、高さ44px以上。320pxでも使えること。ファイル編集はこのワークスペース内だけ。構成をシンプルにし、各案の違いが明確に見えるものを。",
      criteria: "ログイン不要\nスマートフォンで使える\n準備中も下に表示する",
      variantA:
        "展示名と説明を大きなカードで並べる。深い緑と生成りの静かなデザイン。ページ最初の見出しを『展示を一覧で』にする。",
      variantB:
        "場所番号と所要時間を先頭に、コンパクトな表形式で探せる。青と白の明快なデザイン。ページ最初の見出しを『場所から見つける』にする。",
    });
let overlap = false;
for (;;) {
  snapshot = await api(snapshotPath);
  const tasks = snapshot.tasks.filter((task) =>
    accepted.taskIds.includes(task.id),
  );
  if (tasks.length === 2 && tasks.every((task) => task.state === "running"))
    overlap = true;
  if (
    tasks.some((task) =>
      ["failed", "cancelled", "interrupted"].includes(task.state),
    )
  )
    throw new Error("A real alternative failed");
  if (
    tasks.length === 2 &&
    tasks.every(
      (task) =>
        task.state === "completed" && task.preview?.state === "available",
    )
  )
    break;
  if (Date.now() - started > 900000)
    throw new Error("Real alternatives exceeded 15 minutes");
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!resumeIds) {
  assert.equal(overlap, true, "Both real Codex tasks ran at the same time");
  await writeFile(
    `${output}/variants-execution.json`,
    JSON.stringify(
      {
        taskIds: accepted.taskIds,
        overlapObserved: overlap,
        elapsedMs: Date.now() - started,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
const browser = await chromium.launch({
  headless: true,
  ...(process.env.HUD_BROWSER_EXECUTABLE
    ? { executablePath: process.env.HUD_BROWSER_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto(origin + "/studio");
  await page.getByLabel("表示名", { exact: true }).fill("比較の検証");
  await page
    .getByLabel("接続コード", { exact: true })
    .fill(access.operatorCode);
  await page.getByRole("button", { name: "共有スタジオに入る" }).click();
  await page.getByText("エンジン接続中", { exact: true }).waitFor();
  const tasks = accepted.taskIds.map((id) =>
    snapshot.tasks.find((task) => task.id === id),
  );
  await page.locator(".task-item").filter({ hasText: tasks[0].title }).click();
  await page
    .getByLabel("比較する成果", { exact: true })
    .selectOption(tasks[1].id);
  await page
    .frameLocator("iframe")
    .first()
    .getByRole("heading", { name: "展示を一覧で", exact: true })
    .waitFor();
  await page
    .frameLocator("iframe")
    .nth(1)
    .getByRole("heading", { name: "場所から見つける", exact: true })
    .waitFor();
  for (let index = 0; index < 2; index++) {
    await page
      .frameLocator("iframe")
      .nth(index)
      .getByRole("button", { name: "いま体験できる", exact: true })
      .click();
    await page
      .frameLocator("iframe")
      .nth(index)
      .getByText("体験できる展示", { exact: true })
      .waitFor();
  }
  await page.screenshot({
    path: `${output}/06-real-variants.png`,
    fullPage: true,
  });
  const evidence = {
    passed: true,
    execution: "real Codex",
    overlapObserved: resumeIds ? null : overlap,
    resumedExistingTasks: Boolean(resumeIds),
    verificationElapsedMs: Date.now() - started,
    tasks: tasks.map((task) => ({
      id: task.id,
      browserVerified: task.preview.browserVerified,
      runRevision: task.runRevision,
      specRevision: task.specRevision,
    })),
    restartPreviewPassed: true,
  };
  await writeFile(
    `${output}/variants-summary.json`,
    JSON.stringify(evidence, null, 2),
    { mode: 0o600 },
  );
  console.log(JSON.stringify(evidence));
} finally {
  await browser.close();
}
