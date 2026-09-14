import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Client } from "../src/bootstrap/client.js";
import { Executor, type Run } from "../src/execution/executor.js";
import { recordActivity } from "../src/execution/activity.js";
import { localProgress } from "../src/execution/local-tasks.js";

test("local tasks start offline once, enforce slots and CSRF, persist origin and never report to Engine", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-local-task-"));
  const repo = join(directory, "repo");
  await mkdir(repo);
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], {
      windowsHide: true,
      stdio: "pipe",
    });
  git("init");
  await writeFile(join(repo, "readme.txt"), "fixture");
  git("add", "readme.txt");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-m",
    "fixture",
  );
  const client = new Client(join(directory, "client"));
  client.credentials.backend = "file";
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.start(0);
  const frames: unknown[] = [];
  client.emit = (frame) => {
    frames.push(frame);
  };
  let executions = 0;
  client.executor.execute = async (value: Run) => {
    executions++;
    value.state = "running";
    client.executor.report(value);
  };
  const post = (path: string, input: unknown, csrf = client.csrf) =>
    fetch(`${client.origin}/api/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": csrf,
        origin: client.origin,
      },
      body: JSON.stringify(input),
    });
  const input = {
    requestKey: "one",
    model: "test-model",
    title: "Local test",
    text: "private local instruction",
    directory: repo,
    mode: "manual",
    sandboxMode: "read-only",
    network: false,
  };
  assert.equal((await post("local-tasks/start", input, "invalid")).status, 403);
  const [first, duplicate] = await Promise.all([
    post("local-tasks/start", input),
    post("local-tasks/start", input),
  ]);
  assert.equal(first.status, 200);
  assert.equal(duplicate.status, 200);
  const { runId } = await first.json();
  assert.equal((await duplicate.json()).runId, runId);
  assert.equal(executions, 1);
  const value = client.executor.runs[runId];
  assert.equal(value.origin, "local");
  assert.equal(value.model, "test-model");
  assert.equal(value.progressMode, "manual");
  assert.equal(value.task.executionPolicy?.sandboxMode, "read-only");
  assert.equal(value.task.network, false);
  assert.equal(client.allow, false);
  assert.equal(client.connected, false);
  assert.equal(
    (await post("local-tasks/start", { ...input, requestKey: "two" })).status,
    409,
  );
  await assert.rejects(
    client.executor.receive(
      { v: 1, type: "stop", id: "remote-stop", runId, taskId: value.task.id },
      [],
      true,
      1,
    ),
    /TASK_ORIGIN_MISMATCH/,
  );
  recordActivity(value, {
    kind: "command",
    title: "command",
    text: "private command output",
  });
  const progress = await (
    await fetch(client.origin + "/api/local-tasks/progress")
  ).json();
  assert.equal(progress.schemaVersion, 1);
  assert.equal(progress.sharing, "not-connected");
  assert.equal(progress.tasks[0].state, "running");
  const payload = JSON.stringify(progress);
  const unchanged = localProgress(client.executor.runs);
  assert.equal(unchanged.tasks[0].changeToken, progress.tasks[0].changeToken);
  value.phase = "awaiting-plan";
  assert.notEqual(
    localProgress(client.executor.runs).tasks[0].changeToken,
    progress.tasks[0].changeToken,
  );
  value.phase = undefined;
  assert.ok(!payload.includes("private"));
  assert.ok(!payload.includes(repo));
  assert.equal(
    (
      await fetch(client.origin + "/api/local-tasks/progress", {
        headers: { origin: "https://foreign.example" },
      })
    ).status,
    403,
  );
  assert.equal((await post("preview", { runId, port: 3000 })).status, 409);
  assert.equal(
    (
      await post("instruction", {
        runId,
        requestKey: "follow",
        instruction: "check again",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await post("instruction", {
        runId,
        requestKey: "follow",
        instruction: "check again",
      })
    ).status,
    200,
  );
  assert.equal(value.instructions?.length, 1);
  await client.executor.save();
  const restored = new Executor(client.directory, (data) => frames.push(data));
  await restored.load();
  assert.equal(restored.runs[runId].origin, "local");
  assert.equal(restored.runs[runId].state, "interrupted");
  restored.report(restored.runs[runId]);
  assert.equal((await post("stop", { runId })).status, 200);
  assert.equal(value.state, "cancelled");
  assert.deepEqual(frames, []);
});
