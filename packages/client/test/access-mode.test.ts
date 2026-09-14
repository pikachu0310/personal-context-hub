import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../src/bootstrap/client.js";
import type { Task } from "@ido/common/contracts/protocol";
import { HttpError } from "@ido/common/runtime/http";

test("project access is independent of progress, durable, and only adopted by new runs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-project-access-"));
  const client = new Client(directory);
  client.credentials.backend = "file";
  t.mock.method(client, "checkAccount", async () => {});
  t.mock.method(client.executor, "execute", async () => {});
  await client.start(0);
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  client.settings.projects = ["alpha", "beta"].map((id) => ({
    id,
    name: id,
    remote: "",
  }));
  client.settings.slots = 8;
  client.settings.mappings = client.settings.projects.map(({ id }) => ({
    projectId: id,
    directory,
    network: false,
    slots: 8,
  }));
  client.allowedProjects.add("alpha");
  const post = (path: string, input: unknown) =>
    fetch(`${client.origin}/api/${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": client.csrf,
      },
      body: JSON.stringify(input),
    });
  const mapping = client.settings.mappings[0];
  const task: Task = {
    id: "original",
    runId: "original",
    requestId: "original",
    projectId: "alpha",
    meetingId: "test",
    authorId: "user",
    text: "Example",
    revision: 1,
    state: "assigned",
    network: false,
    createdAt: 1,
    updatedAt: 1,
    history: [],
  };
  const deliver = (task: Task, type: "execute" | "retry" = "execute") =>
    client.executor.receive(
      {
        v: 1,
        type,
        id: `${task.runId}-${task.revision}`,
        taskId: task.id,
        runId: task.runId,
        task,
      },
      client.executionMappings(),
      client.allow,
      8,
    );
  // Old settings and tasks without an explicit access mode keep their behavior.
  await deliver(task);
  assert.equal(client.executor.runs.original.accessMode, undefined);
  client.executor.runs.original.state = "completed";
  for (const mode of ["auto", "manual"] as const) {
    for (const accessMode of ["full", "approval", "sandbox"] as const) {
      assert.equal(
        (await post("access-mode", { projectId: "alpha", accessMode })).status,
        200,
      );
      assert.equal(
        (await post("progress-mode", { projectId: "alpha", mode })).status,
        200,
      );
      assert.equal(mapping.accessMode, accessMode);
      assert.equal(mapping.progressMode, mode);
      assert.equal(mapping.network, false);
      assert.equal(client.grants()[0].network, accessMode !== "sandbox");
      assert.equal(client.settings.mappings[1].accessMode, undefined);
      const runId = `${mode}-${accessMode}`;
      await deliver({ ...task, id: runId, runId });
      assert.equal(client.executor.runs[runId].accessMode, accessMode);
      assert.equal(client.executor.runs[runId].progressMode, mode);
      client.executor.runs[runId].state = "completed";
    }
  }
  await deliver({ ...task, revision: 2 }, "retry");
  assert.equal(client.executor.runs.original.accessMode, undefined);
  const originalFull = client.executor.runs["auto-full"];
  await deliver({ ...originalFull.task, revision: 2 }, "retry");
  assert.equal(client.executor.runs["auto-full"].accessMode, "full");

  // The legacy combined endpoint accepts the requested mode without escalation.
  mapping.network = true;
  assert.equal(
    (
      await post("progress-mode", {
        projectId: "alpha",
        mode: "auto",
        accessMode: "approval",
      })
    ).status,
    200,
  );
  assert.equal(mapping.accessMode, "approval");
  assert.equal(mapping.network, true);
  assert.equal(
    (await post("allow", { projectId: "alpha", slots: 2 })).status,
    200,
  );
  assert.equal(client.allowedProjects.has("alpha"), true);
  assert.equal(mapping.slots, 2);
  const before = structuredClone(mapping);
  for (const accessMode of [null, "invalid", {}, undefined]) {
    assert.equal(
      (await post("access-mode", { projectId: "alpha", accessMode })).status,
      400,
    );
    assert.deepEqual(mapping, before);
  }
  assert.equal(
    (
      await post("progress-mode", {
        projectId: "alpha",
        mode: "manual",
        accessMode: "invalid",
      })
    ).status,
    400,
  );
  assert.deepEqual(mapping, before);
  assert.equal(
    (await post("access-mode", { projectId: "unknown", accessMode: "full" }))
      .status,
    400,
  );
  assert.equal(
    (await post("access-mode", { runId: "original", accessMode: "full" }))
      .status,
    400,
  );
  const noMapping = client.settings.mappings.pop()!;
  assert.equal(
    (await post("access-mode", { projectId: "beta", accessMode: "full" }))
      .status,
    409,
  );
  client.settings.mappings.push(noMapping);
  const failingSave = t.mock.method(client, "save", async () => {
    throw new HttpError(500, "TEST_SAVE_FAILED");
  });
  assert.equal(
    (await post("access-mode", { projectId: "alpha", accessMode: "full" }))
      .status,
    500,
  );
  assert.deepEqual(mapping, before);
  failingSave.mock.restore();
  const state = await (await fetch(`${client.origin}/api/state`)).json();
  assert.equal(state.settings.mappings[0].accessMode, "approval");
  await client.close();

  const restored = new Client(directory);
  restored.credentials.backend = "file";
  t.mock.method(restored, "checkAccount", async () => {});
  await restored.start(0);
  try {
    assert.equal(restored.settings.mappings[0].accessMode, "approval");
    assert.equal(restored.settings.mappings[0].network, true);
    assert.deepEqual([...restored.allowedProjects], ["alpha"]);
    assert.equal(restored.executor.runs["auto-full"].accessMode, "full");
    assert.equal(restored.executor.runs["auto-sandbox"].accessMode, "sandbox");
    assert.equal(restored.executor.runs.original.accessMode, undefined);
    restored.syncProjects([...restored.settings.projects]);
    assert.equal(restored.allowedProjects.has("alpha"), true);
    restored.syncProjects(
      restored.settings.projects.filter((p) => p.id !== "alpha"),
    );
    await restored.save();
    assert.equal(restored.allowedProjects.has("alpha"), false);
    restored.syncProjects([
      ...restored.settings.projects,
      { id: "alpha", name: "Alpha", remote: "" },
    ]);
    assert.equal(restored.allowedProjects.has("alpha"), false);
  } finally {
    await restored.close();
  }
});

test("execution Off survives restart and failed permission saves keep the current grant", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-execution-allow-"));
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  const start = async () => {
    const client = new Client(directory);
    client.credentials.backend = "file";
    t.mock.method(client, "checkAccount", async () => {});
    clients.push(client);
    await client.start(0);
    return client;
  };
  const first = await start();
  first.settings.projects = [{ id: "project", name: "Project", remote: "" }];
  first.settings.mappings = [
    { projectId: "project", directory, network: false, slots: 1 },
  ];
  const post = (allow: unknown) =>
    fetch(`${first.origin}/api/allow`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": first.csrf,
      },
      body: JSON.stringify({ projectId: "project", allow }),
    });
  assert.equal((await post(true)).status, 200);
  const failure = t.mock.method(first, "save", async () => {
    throw new HttpError(500, "TEST_SAVE_FAILED");
  });
  assert.equal((await post(false)).status, 500);
  assert.equal(first.allow, true);
  failure.mock.restore();
  assert.equal((await post("false")).status, 400);
  assert.equal(first.allow, true);
  assert.equal((await post(false)).status, 200);
  assert.equal(first.allow, false);
  await first.close();
  const restored = await start();
  assert.equal(restored.allow, false);
  assert.equal(restored.settings.mappings[0].executionAllowed, false);
});
