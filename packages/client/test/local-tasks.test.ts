import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
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
  let loggedIn = true;
  client.agentCatalog = async () => [
    {
      agent: "codex",
      authenticated: loggedIn,
      models: loggedIn ? [{ id: "test-model", name: "Test" }] : [],
    },
  ];
  client.credentials.backend = "file";
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  t.mock.method(client, "checkAccount", async () => {});
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
  const sourceInput = {
    runId,
    taskId: value.task.id,
    sourceId: "notes",
    kind: "minutes",
    title: "Meeting notes",
    text: "Use the agreed login form",
  };
  assert.equal((await post("task/sources", sourceInput, "wrong")).status, 403);
  assert.equal(
    (await post("task/sources", { ...sourceInput, taskId: "another" })).status,
    404,
  );
  assert.equal((await post("task/sources", sourceInput)).status, 200);
  assert.equal((await post("task/sources", sourceInput)).status, 200);
  assert.equal(value.task.attachedSources?.length, 1);
  assert.equal(executions, 1);
  const persisted = JSON.parse(
    await readFile(join(client.directory, "runs.json"), "utf8"),
  );
  assert.equal(
    persisted.runs[runId].task.attachedSources[0].text,
    sourceInput.text,
  );

  assert.equal(value.model, "test-model");
  loggedIn = false;
  const expired = await post("local-tasks/start", {
    ...input,
    requestKey: "expired",
  });
  assert.equal((await expired.json()).error, "AGENT_LOGIN_REQUIRED");
  loggedIn = true;
  const unavailable = await post("local-tasks/start", {
    ...input,
    requestKey: "invalid-model",
    model: "other",
  });
  assert.equal((await unavailable.json()).error, "MODEL_UNAVAILABLE");
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
  value.state = "completed";
  value.result = "Previous answer";
  value.threadId = "saved-thread";
  const previousDirectory = value.directory;
  const followup = {
    runId,
    requestKey: "continue-one",
    instruction: "Continue using that answer",
    revision: 1,
  };
  assert.equal((await post("continue", followup, "invalid")).status, 403);
  const [continued, repeated] = await Promise.all([
    post("continue", followup),
    post("continue", followup),
  ]);
  assert.equal(continued.status, 200);
  assert.equal(repeated.status, 200);
  const resumed = client.executor.runs[runId];
  assert.equal(executions, 2);
  assert.equal(resumed.task.revision, 2);
  assert.equal(resumed.threadId, "saved-thread");
  assert.equal(resumed.directory, previousDirectory);
  assert.equal(resumed.task.history[0].result, "Previous answer");
  assert.match(resumed.task.text, /Continue using that answer/);
  assert.equal(resumed.model, "test-model");
  assert.equal(resumed.progressMode, "manual");
  assert.equal(resumed.task.executionPolicy?.sandboxMode, "read-only");
  assert.equal(
    (await post("continue", { ...followup, requestKey: "stale" })).status,
    409,
  );
  resumed.state = "completed";
  const auto = await post("local-tasks/start", {
    ...input,
    requestKey: "auto-access",
    mode: "auto",
    accessMode: "approval",
  });
  assert.equal(auto.status, 200);
  const autoRun = client.executor.runs[(await auto.json()).runId];
  assert.equal(autoRun.accessMode, "approval");
  assert.equal(autoRun.task.network, true);
  assert.equal(autoRun.task.executionPolicy?.sandboxMode, undefined);
  client.settings.projects = [
    {
      id: "project",
      name: "Fixture",
      remote: "https://example.invalid/project.git",
    },
  ];
  client.settings.mappings = [
    { projectId: "project", directory: repo, network: false, slots: 1 },
  ];
  assert.equal(
    (
      await post("progress-mode", {
        projectId: "project",
        mode: "auto",
        accessMode: "approval",
      })
    ).status,
    200,
  );
  assert.equal(client.settings.mappings[0].accessMode, "approval");
  assert.equal(client.settings.mappings[0].network, false);
  assert.equal(
    (
      await post("progress-mode", {
        projectId: "project",
        mode: "manual",
        accessMode: "approval",
      })
    ).status,
    200,
  );
  assert.equal(client.settings.mappings[0].accessMode, "approval");
  assert.equal(autoRun.accessMode, "approval");
  autoRun.state = "completed";
  for (const mode of ["auto", "manual"] as const) {
    for (const accessMode of ["sandbox", "approval", "full"] as const) {
      for (const network of [false, true]) {
        const response = await post("local-tasks/start", {
          ...input,
          requestKey: `${mode}-${accessMode}-${network}`,
          mode,
          accessMode,
          network,
          sandboxMode: undefined,
        });
        assert.equal(response.status, 200, await response.clone().text());
        const value = client.executor.runs[(await response.json()).runId];
        assert.equal(value.accessMode, accessMode);
        assert.equal(value.progressMode, mode);
        assert.equal(
          value.task.executionPolicy?.sandboxMode,
          accessMode === "sandbox" ? "workspace-write" : undefined,
        );
        assert.equal(
          value.task.network,
          accessMode === "sandbox" ? network : true,
        );
        value.state = "completed";
      }
    }
  }
  const count = Object.keys(client.executor.runs).length;
  assert.equal(
    (
      await post("local-tasks/start", {
        ...input,
        requestKey: "bad-access",
        accessMode: "invalid",
      })
    ).status,
    400,
  );
  const catalog = client.agentCatalog;
  client.agentCatalog = async () => [
    {
      agent: "claude",
      authenticated: true,
      models: [{ id: "test-model", name: "Test" }],
    },
  ];
  const unsupported = await post("local-tasks/start", {
    ...input,
    requestKey: "claude-sandbox",
    agent: "claude",
    accessMode: "sandbox",
  });
  assert.equal(unsupported.status, 400);
  assert.equal((await unsupported.json()).error, "CLAUDE_SANDBOX_UNSUPPORTED");
  assert.equal(Object.keys(client.executor.runs).length, count);
  client.agentCatalog = catalog;
  client.settings.engineUrl = "https://team.example";
  client.settings.deviceId = "fixture-device";
  const shared = await post("local-tasks/start", {
    ...input,
    requestKey: "shared-local",
    shareDiscord: true,
    shareProjectId: "project",
  });
  assert.equal(shared.status, 200);
  const sharedRun = client.executor.runs[(await shared.json()).runId];
  assert.equal(sharedRun.origin, "local");
  assert.equal(sharedRun.discordShare?.projectId, "project");
  assert.equal(sharedRun.discordShare?.engineUrl, "https://team.example");
  assert.equal(sharedRun.discordShare?.status, "pending");
  await client.executor.save();
  const restoredShare = new Executor(client.directory, () => {});
  await restoredShare.load();
  assert.equal(
    restoredShare.runs[sharedRun.task.runId].discordShare?.deviceId,
    "fixture-device",
  );
  assert.deepEqual(frames, []);
});
