import test from "node:test";
import assert from "node:assert/strict";
import { AgentTaskMonitor } from "../src/discord-agent-task-monitor.mjs";
import { AgentExecutionConsent } from "../src/discord-agent-execution-consent.mjs";
import {
  allowedDesktopRequest,
  allowedExternalUrl,
} from "../desktop/security.mjs";
import { agentGuideComponents } from "../src/discord-agent-onboarding.mjs";
import { LocalCodexTasks } from "../desktop/local-tasks.mjs";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("desktop limits IPC routes, payloads and external navigation", () => {
  assert.equal(allowedDesktopRequest("/status"), true);
  for (const path of [
    "/status?token=x",
    "https://evil.example",
    "/../connect",
    "/exec",
    "/status",
  ])
    assert.equal(allowedDesktopRequest(path, {}), false);
  assert.equal(
    allowedDesktopRequest("/connect", { workingDirectory: "repo" }),
    true,
  );
  assert.equal(
    allowedDesktopRequest("/connect", { text: "x".repeat(16001) }),
    false,
  );
  assert.equal(allowedExternalUrl("https://auth.openai.com/authorize"), true);
  assert.equal(allowedDesktopRequest("/local-tasks", { enabled: true }), true);
  assert.equal(
    allowedDesktopRequest("/local-tasks", { enabled: true, path: "elsewhere" }),
    false,
  );
  for (const url of [
    "file:///tmp/file",
    "javascript:alert(1)",
    "https://auth.openai.com.evil.example",
    "https://user@auth.openai.com/",
  ])
    assert.equal(allowedExternalUrl(url), false);
  assert.throws(() =>
    agentGuideComponents(undefined, undefined, "http://example.com/setup.exe"),
  );
  const [row] = agentGuideComponents(
    undefined,
    undefined,
    "https://example.com/setup.exe",
  );
  assert.equal(row.components[0].url, "https://example.com/setup.exe");
});

test("external Codex tasks are opt-in, bounded metadata with unknown execution state", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const directory = await mkdtemp(join(tmpdir(), "ido-local-tasks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const now = Date.now();
  const path = join(directory, "state_5.sqlite");
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TABLE threads (id TEXT, title TEXT, cwd TEXT, created_at INTEGER, updated_at INTEGER, archived INTEGER, has_user_event INTEGER, first_user_message TEXT)",
  );
  const insert = db.prepare(
    "INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < 40; i++)
    insert.run(
      String(i),
      `Task ${i}`,
      "sample/repository",
      now / 1000 - 60,
      now / 1000 - i,
      0,
      1,
      "private conversation must not be exposed",
    );
  insert.run(
    "archived",
    "archived task",
    "sample",
    now / 1000,
    now / 1000,
    1,
    1,
    "private",
  );
  insert.run("old", "old task", "sample", 0, 0, 0, 1, "private");
  db.close();
  await writeFile(join(directory, "auth.json"), "must not be parsed");
  const before = await readFile(path);
  const reader = new LocalCodexTasks({ directory, now: () => now });
  assert.deepEqual(await reader.list(), { enabled: false, tasks: [] });
  reader.setEnabled(true);
  const result = await reader.list();
  assert.equal(result.available, true);
  assert.equal(result.tasks.length, 30);
  assert.equal(result.tasks[0].title, "Task 0");
  assert.equal(
    result.tasks.every((task) => task.state === "external"),
    true,
  );
  assert.doesNotMatch(JSON.stringify(result), /private|archived task|old task/);
  assert.deepEqual(await readFile(path), before);
  reader.setEnabled(false);
  assert.deepEqual(await reader.list(), { enabled: false, tasks: [] });
  await rm(path);
  reader.setEnabled(true);
  assert.equal((await reader.list()).available, false);
});

test("local task monitor shows approval, progress and cancellation and waits for shutdown", async () => {
  const monitor = new AgentTaskMonitor({ limit: 2 });
  let stopped = false;
  const consent = new AgentExecutionConsent({
    executor: {
      run: async (task, { signal, onProgress }) => {
        monitor.markRunning(task.id);
        await onProgress("READMEを確認しています");
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        stopped = true;
        signal.throwIfAborted();
      },
    },
  });
  const result = monitor.wrap(consent).run({ id: "one", title: "調査" });
  const rejected = assert.rejects(result);
  await new Promise((r) => setImmediate(r));
  assert.equal(monitor.list()[0].state, "awaiting_approval");
  consent.decide(consent.describe()[0].id, true);
  await new Promise((r) => setImmediate(r));
  assert.equal(monitor.list()[0].state, "running");
  assert.match(monitor.list()[0].logs[0].text, /README/);
  assert.equal(monitor.cancel("unknown"), false);
  await monitor.close();
  await rejected;
  assert.equal(stopped, true);
  assert.equal(monitor.list()[0].state, "cancelled");
  const completed = monitor.wrap(
    { run: async () => ({ response: "完了" }) },
    { automatic: true },
  );
  await completed.run({ id: "two" });
  await completed.run({ id: "three" });
  assert.equal(monitor.list().length, 2);
  assert.equal(monitor.list()[0].result, "完了");
});
