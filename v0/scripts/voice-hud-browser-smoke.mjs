/* global document, innerWidth */
// Synthetic browser fixtures only; the production HUD has no demo/replay mode.
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium } from "playwright";
import { startHudServer } from "../src/runtime/hud-server.mjs";
const requireUi = createRequire(new URL("../ui/package.json", import.meta.url));
const ts = requireUi("typescript");
const compiled = ts.transpileModule(
  await readFile(new URL("../ui/src/model.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  },
).outputText;
const { append, spans } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);
const state = { sessionId: "fixture", sequence: 1, events: [] };
assert.equal(append(state, { sessionId: "fixture", sequence: 1 }), state);
assert.equal(append(state, { sessionId: "fixture", sequence: 3 }), null);
assert.equal(append(state, { sessionId: "old", sequence: 2 }), null);
assert.equal(append(state, { sessionId: "fixture", sequence: 2 }).sequence, 2);
assert.equal(
  spans([
    { spanId: "s", at: 1, status: "running" },
    { spanId: "s", at: 5, status: "completed" },
  ])[0].start,
  1,
);

const server = await startHudServer({ port: 0 });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.HUD_BROWSER_EXECUTABLE
    ? { executablePath: process.env.HUD_BROWSER_EXECUTABLE }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
  });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.getByText("接続中", { exact: true }).waitFor();
  await page.getByText("発話を待っています", { exact: false }).waitFor();
  assert.equal(await page.locator(".feed-card").count(), 0);
  const publish = (event) =>
    server.store.publish({
      at: Date.now() - 3500,
      inputIds: ["fixture:I-01"],
      ...event,
    });
  publish({
    stage: "ASSEMBLE",
    status: "completed",
    spanId: "input1",
    speaker: "テスト話者A",
    text: "音声認識の遅延を調べて",
  });
  publish({
    stage: "ASSEMBLE",
    status: "completed",
    spanId: "input2",
    inputIds: ["fixture:I-02"],
    speaker: "テスト話者B",
    text: "比較もお願い",
  });
  for (const stage of [
    "AUDIO",
    "STT",
    "ASSEMBLE",
    "OBSERVE",
    "TTS",
    "PLAYBACK",
  ])
    publish({
      stage,
      status: stage === "TTS" ? "waiting" : "running",
      spanId: `parallel-${stage}`,
      reason: stage === "TTS" ? "playback_queue" : undefined,
      inputIds: ["fixture:I-03"],
    });
  publish({
    stage: "IMMEDIATE",
    status: "completed",
    spanId: "immediate",
    inputIds: ["fixture:I-03"],
  });
  publish({
    stage: "EXECUTE",
    status: "running",
    spanId: "task-T-01",
    taskId: "T-01",
    title: "遅延調査",
    inputIds: ["fixture:I-01", "fixture:I-02"],
  });
  publish({
    stage: "EXECUTE",
    status: "running",
    spanId: "tool1",
    taskId: "T-01",
    tool: "web_search",
    query: "streaming STT latency comparison",
    inputIds: ["fixture:I-01", "fixture:I-02"],
    runId: "1",
  });
  publish({
    stage: "QUEUE",
    status: "waiting",
    spanId: "task-T-02",
    taskId: "T-02",
    title: "要約",
    inputIds: ["fixture:I-03"],
    reason: "execution_capacity",
  });
  publish({
    stage: "EXECUTE",
    status: "failed",
    spanId: "task-T-04",
    taskId: "T-04",
    title: "資料確認",
    reason: "timeout",
    inputIds: ["fixture:I-04"],
  });
  publish({
    stage: "DELIVER",
    status: "completed",
    spanId: "delivery",
    taskId: "T-00",
    text: "結果を短くまとめました",
  });
  await page
    .locator(".feed-card")
    .filter({ hasText: "音声認識の遅延を調べて" })
    .click();
  await page
    .locator(".detail")
    .getByText("streaming STT latency comparison", { exact: true })
    .waitFor();
  assert.ok((await page.locator(".stage .selected").count()) > 0);
  assert.ok((await page.locator(".timeline .selected-row").count()) > 0);
  assert.ok(
    (await page
      .locator(".detail")
      .getByText("未提供", { exact: true })
      .count()) > 0,
  );
  assert.ok((await page.locator(".event.failed").count()) > 0);
  await page
    .locator(".stage .event")
    .filter({ hasText: "T-01" })
    .first()
    .click();
  assert.equal(await page.locator(".detail .chips button").count(), 2);
  if (process.env.HUD_SCREENSHOT_DIRECTORY) {
    await mkdir(process.env.HUD_SCREENSHOT_DIRECTORY, { recursive: true });
    await page.screenshot({
      path: `${process.env.HUD_SCREENSHOT_DIRECTORY}/hud-1920.png`,
      fullPage: true,
    });
  }
  await page.getByRole("switch", { name: "本文を隠す" }).click();
  const hidden = await page.locator("body").innerText();
  for (const secret of [
    "テスト話者A",
    "テスト話者B",
    "音声認識の遅延を調べて",
    "比較もお願い",
    "遅延調査",
    "streaming STT latency comparison",
    "結果を短くまとめました",
  ])
    assert.ok(!hidden.includes(secret), `hidden text leaked: ${secret}`);
  await page.getByRole("switch", { name: "本文を隠す" }).click();
  await page.setViewportSize({ width: 1366, height: 768 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.locator(".timeline").scrollIntoViewIfNeeded();
  if (process.env.HUD_SCREENSHOT_DIRECTORY)
    await page.screenshot({
      path: `${process.env.HUD_SCREENSHOT_DIRECTORY}/hud-1366.png`,
      fullPage: true,
    });
  await page.context().setOffline(true);
  await page.getByText("通信断", { exact: true }).waitFor();
  // Push beyond the memory window while disconnected, forcing snapshot recovery.
  for (let i = 0; i < 1002; i++)
    publish({ stage: "AUDIO", status: "completed", spanId: `gap-${i}` });
  publish({
    stage: "ASSEMBLE",
    status: "completed",
    spanId: "restored",
    text: "復旧テスト",
    inputIds: ["fixture:I-99"],
  });
  await page.context().setOffline(false);
  await page.getByText("接続中", { exact: true }).waitFor();
  await page.locator(".feed-card").filter({ hasText: "復旧テスト" }).waitFor();
  assert.equal(await page.locator(".feed-card").count(), 1);
  assert.deepEqual(errors, []);
  console.log(
    "HUD browser smoke passed: selection, privacy, responsive layout, disconnect/recovery, gaps and deduplication.",
  );
} finally {
  await browser.close();
  await server.close();
}
