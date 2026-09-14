import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PluginProcess } from "../src/adapters/plugins/process.js";
import { Engine } from "../src/bootstrap/engine.js";
async function setup(t: { after(fn: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(tmpdir(), "ido-plugins-"));
  // These fixtures exercise the compatibility minutes pipeline and plugin
  // isolation. The default persistent coordinator has its own integration suite.
  const engine = new Engine({
    directory,
    port: 0,
    previewPort: 0,
    conversation: false,
  });
  const user = engine.store.createUser("admin", "test-password-long", "admin");
  engine.store.put("project", "project", { id: "project", name: "Project" });
  engine.store.put("meeting", "meeting", {
    id: "meeting",
    name: "Meeting",
    projectId: "project",
    summary: "",
    messages: [],
  });
  engine.conversation.models.update = async () => ({
    minutes: "Shared minutes",
    task: "Implement requested page",
  });
  engine.conversation.transcribe = async () => "実装してください";
  engine.plugins.catalog.push({
    id: "fixture",
    package: "fixture",
    version: "0.2.0",
    builtin: fileURLToPath(new URL("./fixtures/plugin.mjs", import.meta.url)),
  });
  engine.store.put("config", "fixture", {
    meetingId: "meeting",
    projectId: "project",
  });
  await engine.listen();
  t.after(async () => {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });
  const response = await fetch(engine.origin + "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "admin", password: "test-password-long" }),
  });
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const { csrf } = (await response.json()) as { csrf: string };
  const headers = {
    cookie,
    "x-csrf-token": csrf,
    "content-type": "application/json",
  };
  const post = (path: string, data: unknown) =>
    fetch(engine.origin + path, {
      method: "POST",
      headers,
      body: JSON.stringify(data),
    });
  return { engine, user, directory, headers, post };
}
test("Dashboard is a child process; authenticated workspace APIs and management remain independent", async (t) => {
  const { engine, headers, post } = await setup(t);
  const dashboard = engine.plugins.get("dashboard");
  assert.ok(dashboard.child?.pid);
  assert.notEqual(dashboard.child.pid, process.pid);
  assert.equal(
    (await fetch(engine.origin + "/dashboard/api/state")).status,
    401,
  );
  assert.equal(
    (
      await fetch(engine.origin + "/dashboard/api/state", {
        headers: { "x-ido-context": "forged" },
      })
    ).status,
    401,
  );
  const response = await post("/dashboard/api/projects", {
    name: "From dashboard",
  });
  assert.equal(response.status, 200);
  assert.ok(
    engine.store
      .list<{ name: string }>("project")
      .some((p) => p.name === "From dashboard"),
  );
  assert.equal(
    (await fetch(engine.origin + "/dashboard/api/state", { headers })).status,
    200,
  );
  await dashboard.stop();
  assert.equal(
    (await fetch(engine.origin + "/dashboard/api/state", { headers })).status,
    503,
  );
  assert.equal(
    (await fetch(engine.origin + "/api/admin/state", { headers })).status,
    200,
  );
  assert.equal(
    (await post("/api/admin/plugins/start", { pluginId: "dashboard" })).status,
    200,
  );
  assert.equal(
    (await fetch(engine.origin + "/dashboard/api/state", { headers })).status,
    200,
  );
  assert.equal(
    (await fetch(engine.origin + "/api/projects", { headers })).status,
    404,
  );
});
test("third plugin uses the shared input/query contract, deduplicates, and works without Dashboard", async (t) => {
  const { engine, headers } = await setup(t);
  await engine.plugins.start("fixture");
  await engine.plugins.get("dashboard").stop();
  const plugin = engine.plugins.get("fixture");
  const input = {
    eventId: "same",
    subject: "speaker",
    meetingId: "meeting",
    projectId: "project",
    audio: "dGVzdA==",
  };
  await plugin.request("test.request", { operation: "input", input });
  await plugin.request("test.request", { operation: "input", input });
  assert.equal(engine.store.list("task").length, 1);
  assert.equal(engine.store.list("message").length, 1);
  const state = (await (
    await fetch(engine.origin + "/plugins/fixture/api/state", { headers })
  ).json()) as { tasks: unknown[]; meetings: Array<{ summary: string }> };
  assert.equal(state.tasks.length, 1);
  assert.equal(state.meetings[0].summary, "Shared minutes");
  const outputs =
    await plugin.request<Array<{ type?: string }>>("test.outputs");
  assert.ok(outputs.some((output) => output.type === "minutes"));
  await assert.rejects(
    plugin.request("test.request", {
      operation: "input",
      input: { ...input, eventId: "other", meetingId: "wrong" },
    }),
    /INPUT_BINDING_MISMATCH/,
  );
});
test("plugin generations fence pending transcription and request-scoped credentials", async (t) => {
  const { engine, user } = await setup(t);
  await engine.plugins.start("fixture");
  const plugin = engine.plugins.get("fixture");
  const token = engine.contexts.issue(
    "fixture",
    user.id,
    plugin.generation,
    "member",
  );
  await assert.rejects(
    engine.broker.request("dashboard", "state", {}, token),
    /LOGIN_REQUIRED/,
  );
  let release!: (text: string) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  engine.conversation.transcribe = () => {
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const running = plugin.request("test.request", {
    operation: "input",
    input: {
      eventId: "pending",
      subject: "speaker",
      meetingId: "meeting",
      projectId: "project",
      audio: "dGVzdA==",
    },
  });
  await ready;
  await plugin.request("test.invalidate");
  release("Do not execute");
  await running;
  assert.equal(engine.store.list("task").length, 0);
  await plugin.stop();
  await assert.rejects(
    engine.broker.request("fixture", "state", {}, token),
    /LOGIN_REQUIRED/,
  );
});
test("viewer and Activity contexts cannot escalate through plugin queries", async (t) => {
  const { engine } = await setup(t);
  await engine.plugins.start("fixture");
  const plugin = engine.plugins.get("fixture");
  const viewer = engine.store.createUser(
    "viewer",
    "test-password-long",
    "viewer",
  );
  const token = engine.contexts.issue(
    "fixture",
    viewer.id,
    plugin.generation,
    "member",
  );
  await assert.rejects(
    engine.broker.request("fixture", "tasks", { role: "admin" }, token),
    /PERMISSION_DENIED/,
  );
  const member = engine.store.createUser(
    "member",
    "test-password-long",
    "member",
  );
  const activity = engine.contexts.issue(
    "fixture",
    member.id,
    plugin.generation,
    "activity",
  );
  await assert.rejects(
    engine.broker.request(
      "fixture",
      "projects",
      { name: "forbidden" },
      activity,
    ),
    /PERMISSION_DENIED/,
  );
  await assert.rejects(
    engine.broker.request(
      "fixture",
      "identity.link",
      { subject: "forged" },
      activity,
    ),
    /PERMISSION_DENIED/,
  );
  await engine.broker.request("fixture", "storage.put", {
    key: "key",
    value: { messageId: "1" },
  });
  assert.equal(
    await engine.broker.request("dashboard", "storage.get", { key: "key" }),
    undefined,
  );
});
test("protocol mismatch is rejected and the child is stopped", async (t) => {
  const { directory } = await setup(t);
  const source = await readFile(
    new URL("./fixtures/plugin.mjs", import.meta.url),
    "utf8",
  );
  const entry = join(directory, "mismatch.mjs");
  await writeFile(entry, source.replace("protocol: 2", "protocol: 999"));
  const plugin = new PluginProcess(
    "fixture",
    directory,
    async () => undefined,
    () => {},
  );
  await assert.rejects(plugin.launch(entry), /PLUGIN_CONTRACT_MISMATCH/);
  assert.equal(plugin.child, undefined);
});

test("provider configuration is validated by its plugin and secrets remain write-only", async (t) => {
  const { engine, headers, post } = await setup(t);
  engine.credentials.backend = "file";
  engine.plugins.catalog.find((entry) => entry.id === "discord")!.builtin =
    fileURLToPath(
      new URL("../../plugin-discord/dist/index.js", import.meta.url),
    );
  const response = await post("/api/admin/plugins/configure", {
    pluginId: "discord",
    config: {
      userPolicy: "allowlist",
      allowedUserIds: "123,456",
      botToken: "synthetic-test-token",
      meetingId: "meeting",
      projectId: "project",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(
    await engine.credentials.get("discord.botToken"),
    "synthetic-test-token",
  );
  const saved = engine.store.get<Record<string, string>>("config", "discord")!;
  assert.equal(saved.userPolicy, "allowlist");
  assert.equal(saved.botToken, undefined);
  const invalid = await post("/api/admin/plugins/configure", {
    pluginId: "discord",
    config: { userPolicy: "invalid" },
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(engine.store.get("config", "discord"), saved);
  const state = await (
    await fetch(engine.origin + "/api/admin/state", { headers })
  ).text();
  assert.ok(!state.includes("synthetic-test-token"));
  assert.equal(engine.plugins.get("discord").running, false);
  const launch = await fetch(
    engine.origin + "/?frame_id=synthetic&instance_id=test",
    { redirect: "manual" },
  );
  assert.equal(launch.status, 302);
  assert.equal(
    launch.headers.get("location"),
    "/plugins/discord/activity?frame_id=synthetic&instance_id=test",
  );
});

test("a member role change fences an explicit task already waiting for minutes", async (t) => {
  const { engine, user } = await setup(t);
  await engine.plugins.start("fixture");
  const plugin = engine.plugins.get("fixture");
  const token = engine.contexts.issue(
    "fixture",
    user.id,
    plugin.generation,
    "member",
  );
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  engine.conversation.models.update = async () => {
    entered();
    await gate;
    return { minutes: "Recorded", task: null };
  };
  const pending = engine.broker.request(
    "fixture",
    "input",
    {
      eventId: "role-change",
      meetingId: "meeting",
      projectId: "project",
      text: "Implement it",
      command: "task",
    },
    token,
  );
  await ready;
  engine.store.db
    .prepare("UPDATE users SET role='viewer' WHERE id=?")
    .run(user.id);
  release();
  await pending;
  assert.equal(engine.store.list("task").length, 0);
});
