import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../src/bootstrap/client.js";
import type { Task } from "@ido/common/contracts/protocol";

test("project execution grants and progress modes are isolated and new runs retain their accepted mode", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-project-settings-"));
  const client = new Client(directory);
  client.credentials.backend = "file";
  t.mock.method(client, "checkAccount", async () => {});
  await client.start(0);
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  client.settings.projects = [
    { id: "alpha", name: "Alpha", remote: "" },
    { id: "beta", name: "Beta", remote: "" },
  ];
  client.settings.mappings = client.settings.projects.map((p) => ({
    projectId: p.id,
    directory,
    network: false,
    slots: 4,
  }));
  const post = (path: string, input: unknown) =>
    fetch(client.origin + "/api/" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": client.csrf,
      },
      body: JSON.stringify(input),
    });
  assert.equal(
    (await post("allow", { projectId: "alpha", allow: true, slots: 4 })).status,
    200,
  );
  assert.deepEqual(client.grants(), [
    { projectId: "alpha", network: false, slots: 4 },
  ]);
  assert.equal(
    (await post("progress-mode", { projectId: "alpha", mode: "manual" }))
      .status,
    200,
  );
  assert.equal(
    (await post("progress-mode", { projectId: "beta", mode: "auto" })).status,
    200,
  );
  t.mock.method(client.executor, "execute", async () => {});
  const task = (projectId: string, runId: string): Task => ({
    id: runId,
    runId,
    revision: 1,
    state: "assigned",
    projectId,
    meetingId: "minutes",
    authorId: "user",
    requestId: runId,
    text: "Example",
    network: false,
    createdAt: 1,
    updatedAt: 1,
    history: [],
  });
  const deliver = async (value: Task) =>
    client.executor.receive(
      {
        v: 1,
        id: "command-" + value.runId,
        type: "execute",
        taskId: value.id,
        runId: value.runId,
        task: value,
      },
      client.executionMappings(),
      client.allow,
      client.settings.slots,
    );
  await deliver(task("beta", "blocked"));
  assert.equal(client.executor.runs.blocked, undefined);
  await deliver(task("alpha", "manual"));
  assert.equal(client.executor.runs.manual.progressMode, "manual");
  assert.equal(
    (await post("progress-mode", { projectId: "alpha", mode: "auto" })).status,
    200,
  );
  await deliver(task("alpha", "automatic"));
  assert.equal(client.executor.runs.automatic.progressMode, "auto");
  assert.equal(client.executor.runs.manual.progressMode, "manual");
  assert.equal(
    (await post("allow", { projectId: "beta", allow: true })).status,
    200,
  );
  assert.equal(
    (await post("allow", { projectId: "alpha", allow: false })).status,
    200,
  );
  assert.deepEqual(
    client.grants().map((g) => g.projectId),
    ["beta"],
  );
  assert.equal((await post("allow", { allow: true })).status, 400);
  assert.equal(new Client(directory).allow, false);
});

test("project creation applies network, progress mode and execution opt-in before readiness", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-project-options-"));
  const client = new Client(directory);
  client.credentials.backend = "file";
  t.mock.method(client, "checkAccount", async () => {});
  await client.start(0);
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  client.connected = true;
  client.projectCreationSupported = true;
  t.mock.method(client, "createProject", async () => ({
    id: "alpha",
    name: "Alpha",
    remote: "",
  }));
  const { mkdir } = await import("node:fs/promises");
  const projectPath = join(directory, "project");
  await mkdir(projectPath);
  const response = await fetch(client.origin + "/api/projects", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": client.csrf,
    },
    body: JSON.stringify({
      name: "Alpha",
      directory: projectPath,
      network: true,
      progressMode: "manual",
      allow: true,
    }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(client.settings.mappings[0].network, true);
  assert.equal(client.settings.mappings[0].progressMode, "manual");
  assert.deepEqual(client.grants(), [
    { projectId: "alpha", network: true, slots: 1 },
  ]);
  const restored = new Client(directory);
  t.mock.method(restored, "checkAccount", async () => {});
  await restored.start(0);
  try {
    assert.equal(restored.allow, true);
    assert.equal(restored.settings.mappings[0].executionAllowed, true);
  } finally {
    await restored.close();
  }
});
