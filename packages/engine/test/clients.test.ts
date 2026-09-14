import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "../../client/src/bootstrap/client.js";
import type { Run } from "../../client/src/execution/executor.js";
import type { Task } from "@ido/common/contracts/protocol";
import { Engine } from "../src/bootstrap/engine.js";
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("CONDITION_TIMEOUT");
}
test("Engine-created tasks inherit Auto and saved execution permission after Client restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-auto-inheritance-"));
  const engine = new Engine({
    directory: join(directory, "engine"),
    port: 0,
    previewPort: 0,
    conversation: false,
  });
  engine.credentials.backend = "file";
  const user = engine.store.createUser("admin", "test-password-long", "admin");
  engine.store.put("project", "project", {
    id: "project",
    name: "Demo",
    remote: "",
  });
  await engine.listen();
  const clients: Client[] = [];
  const executions: Run[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });
  const start = async () => {
    const client = new Client(join(directory, "client"));
    client.credentials.backend = "file";
    t.mock.method(client, "checkAccount", async () => {
      client.loginStatus = "authenticated";
    });
    client.executor.execute = async (run) => {
      executions.push(run);
      run.state = "completed";
      run.result = "Fixture completed";
      await client.executor.save();
      client.executor.report(run);
    };
    clients.push(client);
    await client.start(0);
    return client;
  };
  const first = await start();
  engine.store.put("device", "device", {
    id: "device",
    name: "Client",
    userId: user.id,
    publicKey: first.settings.publicKey,
    revoked: false,
    generation: 0,
    slots: 1,
    lastAssigned: 0,
    grants: [],
  });
  engine.store.put("project-member", "project:device", {
    projectId: "project",
    deviceId: "device",
  });
  first.settings.deviceId = "device";
  first.settings.engineUrl = engine.origin;
  first.settings.mappings = [
    {
      projectId: "project",
      directory,
      slots: 1,
      network: false,
      progressMode: "auto",
      accessMode: "sandbox",
    },
  ];
  await first.connect();
  await until(() =>
    first.settings.projects.some((project) => project.id === "project"),
  );
  const postAllow = (client: Client, allow: boolean) =>
    fetch(`${client.origin}/api/allow`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": client.csrf,
      },
      body: JSON.stringify({ projectId: "project", allow }),
    });
  assert.equal((await postAllow(first, true)).status, 200);
  await first.close();
  await until(() => !engine.ready.has("device"));

  const restored = await start();
  await until(() => engine.ready.has("device"));
  assert.equal(restored.allowedProjects.has("project"), true);
  // Bot/WorkPort task creation reaches this same TaskService and scheduler.
  const create = (requestId: string, network = false) =>
    engine.tasks.createTask({
      projectId: "project",
      meetingId: "bot-meeting",
      authorId: user.id,
      text: "Fixture task",
      requestId,
      network,
    });
  const task = create("after-restart");
  engine.flush();
  await until(() => executions.length === 1);
  assert.equal(executions[0].task.id, task.id);
  assert.equal(executions[0].progressMode, "auto");
  assert.equal(executions[0].accessMode, "sandbox");
  assert.equal(restored.allowedProjects.has("project"), true);
  const accessResponse = await fetch(`${restored.origin}/api/access-mode`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": restored.csrf,
    },
    body: JSON.stringify({ projectId: "project", accessMode: "full" }),
  });
  assert.equal(accessResponse.status, 200);
  await until(() =>
    engine.store
      .get<any>("device", "device")
      ?.grants.some(
        (grant: any) => grant.projectId === "project" && grant.network,
      ),
  );
  const networkTask = create("full-access-network", true);
  engine.flush();
  await until(() => executions.length === 2);
  assert.equal(executions[1].task.id, networkTask.id);
  assert.equal(executions[1].progressMode, "auto");
  assert.equal(executions[1].accessMode, "full");
  assert.equal(restored.settings.mappings[0].network, false);
  engine.connections.broadcastProjects();
  await restored.connect();
  await until(() => restored.connected && engine.ready.has("device"));
  assert.equal(restored.allowedProjects.has("project"), true);
  assert.equal((await postAllow(restored, false)).status, 200);
  await until(
    () =>
      !engine.store
        .get<any>("device", "device")
        ?.grants.some((grant: any) => grant.projectId === "project"),
  );
  const queued = create("explicit-off");
  engine.flush();
  assert.equal(engine.store.get<Task>("task", queued.id)?.state, "queued");
  assert.equal(executions.length, 2);
});

test("two outbound Clients receive separate tasks; duplicate delivery does not start a second execution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-clients-"));
  const e = new Engine({
    directory: join(directory, "engine"),
    port: 0,
    previewPort: 0,
  });
  e.credentials.backend = "file";
  const user = e.store.createUser("admin", "test-password-long", "admin");
  e.store.put("project", "project", {
    id: "project",
    name: "Demo",
    remote: "",
  });
  await e.listen();
  const clients: Client[] = [];
  const executions: string[] = [];
  t.after(async () => {
    for (const c of clients) await c.close();
    await e.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (let i = 0; i < 2; i++) {
    const c = new Client(join(directory, "client" + i));
    c.credentials.backend = "file";
    t.mock.method(c, "checkAccount", async () => {
      c.loginStatus = "authenticated";
    });
    await c.start(0);
    clients.push(c);
    e.store.put("device", "device" + i, {
      id: "device" + i,
      name: "Client " + i,
      userId: user.id,
      publicKey: c.settings.publicKey,
      revoked: false,
      generation: 0,
      slots: 1,
      lastAssigned: 0,
      grants: [],
    });
    c.settings.deviceId = "device" + i;
    e.store.put("project-member", `project:device${i}`, {
      projectId: "project",
      deviceId: `device${i}`,
    });
    c.settings.engineUrl = e.origin;
    c.settings.mappings = [
      { projectId: "project", directory, network: false, slots: 1 },
    ];
    c.allowedProjects.add("project");
    c.executor.execute = async (run: Run) => {
      executions.push(run.task.runId);
      run.state = "running";
      await c.executor.save();
      c.executor.report(run);
    };
    await c.connect();
  }
  await until(() => e.ready.size === 2);
  const tasks = ["one", "two"].map((requestId) =>
    e.tasks.createTask({
      projectId: "project",
      meetingId: "meeting",
      authorId: user.id,
      text: "test",
      requestId,
      network: false,
    }),
  );
  e.flush();
  await until(() => executions.length === 2);
  e.flush();
  e.flush();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(executions.length, 2);
  assert.notEqual(
    e.store.get<Task>("task", tasks[0].id)?.clientId,
    e.store.get<Task>("task", tasks[1].id)?.clientId,
  );
  clients[0].ws?.terminate();
  await until(() => e.ready.size === 1);
  e.flush();
  assert.equal(executions.length, 2);
});

test("administrative disconnect stops remote runs, preserves local runs and waits for manual reconnect", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-disconnect-client-"));
  const e = new Engine({
    directory: join(directory, "engine"),
    port: 0,
    previewPort: 0,
    conversation: false,
  });
  e.credentials.backend = "file";
  const user = e.store.createUser("admin", "test-password-long", "admin");
  await e.listen();
  const c = new Client(join(directory, "client"));
  c.credentials.backend = "file";
  t.mock.method(c, "checkAccount", async () => {
    c.loginStatus = "authenticated";
  });
  await c.start(0);
  t.after(async () => {
    await c.close();
    await e.close();
    await rm(directory, { recursive: true, force: true });
  });
  e.store.put("device", "device", {
    id: "device",
    name: "Demo",
    userId: user.id,
    publicKey: c.settings.publicKey,
    revoked: false,
    generation: 0,
    grants: [],
    slots: 1,
    lastAssigned: 0,
  });
  c.settings.deviceId = "device";
  c.settings.engineUrl = e.origin;
  await c.connect();
  await until(() => e.ready.has("device"));
  const task: Task = {
    id: "remote",
    requestId: "request",
    projectId: "default",
    meetingId: "meeting",
    authorId: user.id,
    text: "test",
    state: "running",
    runId: "remote",
    revision: 1,
    network: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    history: [],
  };
  c.executor.runs.remote = { task, directory, state: "running" };
  c.executor.runs.local = {
    task: { ...task, id: "local", runId: "local" },
    origin: "local",
    directory,
    state: "running",
  };
  const aborted = new AbortController();
  c.executor.active.set("remote", {
    thread: undefined,
    codex: { close: async () => {} },
    abort: aborted,
  });
  e.peers.get("device")!.close(4004, "disconnected by administrator");
  await until(() => !c.connected);
  await c.processing;
  assert.equal(c.executor.runs.remote.state, "cancelled");
  assert.equal(c.executor.runs.local.state, "running");
  assert.equal(aborted.signal.aborted, true);
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(c.connected, false);
  assert.equal(e.store.get<any>("device", "device").revoked, false);
  await c.connect();
  await until(() => c.connected);
});

test("Client close drains queued commands and settings writes in order", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-client-close-"));
  const c = new Client(directory);
  c.credentials.backend = "file";
  t.mock.method(c, "checkAccount", async () => {});
  await c.start(0);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const writes = [];
  for (let i = 0; i < 20; i++) {
    c.settings.profile = { name: `profile-${i}`, context: "" };
    writes.push(c.save());
  }
  c.processing = c.processing.then(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    c.settings.profile = { name: "last-command", context: "" };
    await c.save();
  });
  await c.close();
  await Promise.all(writes);
  assert.equal(
    JSON.parse(await readFile(join(directory, "client.json"), "utf8")).profile
      .name,
    "last-command",
  );
});
