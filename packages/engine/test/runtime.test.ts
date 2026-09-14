import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import type { Task } from "@ido/common/contracts/protocol";
import { Store, type Device } from "../src/adapters/sqlite/store.js";
import { Engine } from "../src/bootstrap/engine.js";
import { Scheduler } from "../src/clients/scheduler.js";
import { Tasks } from "../src/processing/tasks/service.js";

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "ido-engine-test-"));
  const engine = new Engine({ directory, port: 0, previewPort: 0 });
  engine.credentials.backend = "file";
  engine.store.createUser("admin", "test-password-long", "admin");
  await engine.listen();
  t.after(async () => {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });
  return engine;
}
async function login(
  engine: Engine,
  name = "admin",
  password = "test-password-long",
) {
  const res = await fetch(engine.origin + "/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  assert.equal(res.status, 200);
  return {
    cookie: res.headers.get("set-cookie")!.split(";")[0],
    csrf: ((await res.json()) as any).csrf,
  };
}
async function post(
  engine: Engine,
  path: string,
  data: any,
  session: { cookie: string; csrf: string },
) {
  return fetch(
    engine.origin +
      ([
        "projects",
        "meetings",
        "messages",
        "tasks",
        "task/control",
        "artifact",
        "preview",
      ].includes(path)
        ? "/dashboard/api/"
        : "/api/admin/") +
      path,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: session.cookie,
        "x-csrf-token": session.csrf,
      },
      body: JSON.stringify(data),
    },
  );
}
test("only administrators can read Engine diagnostics", async (t) => {
  const e = await fixture(t);
  const entry = e.store.logError(new Error("OPENAI_KEY_REQUIRED"), {
    source: "discord-voice",
    operation: "audio.transcribe",
    eventId: "private-event",
  });
  assert.equal((await fetch(e.origin + "/api/admin/state")).status, 401);
  for (const role of ["admin", "member", "viewer"] as const) {
    if (role !== "admin") e.store.createUser(role, "test-password-long", role);
    const session = await login(e, role);
    const response = await fetch(e.origin + "/api/admin/state", {
      headers: { cookie: session.cookie },
    });
    const state = (await response.json()) as any;
    assert.deepEqual(
      state.diagnostics.map((d: any) => d.id),
      role === "admin" ? [entry.id] : [],
    );
    if (role !== "admin")
      assert.ok(!JSON.stringify(state).includes("private-event"));
  }
});
test("local bootstrap required; password hashing, write-only secrets, CSRF, role changes and host checks", async (t) => {
  const e = await fixture(t),
    session = await login(e);
  assert.equal(
    (await post(e, "settings", { openai: "test-only-secret" }, session)).status,
    200,
  );
  const res = await fetch(e.origin + "/api/admin/state", {
    headers: { cookie: session.cookie },
  });
  const state = (await res.json()) as any;
  assert.equal(state.secrets.openai, true);
  assert.ok(!JSON.stringify(state).includes("test-only-secret"));
  assert.equal(
    (
      await post(
        e,
        "projects",
        { name: "Denied" },
        { ...session, csrf: "wrong" },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(e.origin + "/api/admin/state", {
        headers: { cookie: session.cookie, Origin: "https://attacker.example" },
      })
    ).status,
    403,
  );
  assert.equal(
    await new Promise((resolve) =>
      request(
        e.origin + "/health",
        { headers: { Host: "attacker.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode);
        },
      ).end(),
    ),
    403,
  );
  assert.equal((await fetch(e.origin + "/api/admin/state")).status, 401);
  const viewer = e.store.createUser("viewer", "test-password-long", "viewer"),
    viewSession = await login(e, "viewer");
  assert.equal(
    (await post(e, "projects", { name: "Denied" }, viewSession)).status,
    403,
  );
  assert.equal(
    (
      await post(
        e,
        "users/role",
        { userId: viewer.id, role: "member" },
        session,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(e.origin + "/api/admin/state", {
        headers: { cookie: viewSession.cookie },
      })
    ).status,
    401,
  );
  assert.ok(
    !String(
      e.store.db.prepare("SELECT password FROM users WHERE name=?").get("admin")
        ?.password,
    ).includes("test-password-long"),
  );
});
test("device pairing is single-use, key-authenticated, fenced across reconnects and revoked remotely", async (t) => {
  const e = await fixture(t),
    session = await login(e);
  const keys = generateKeyPairSync("ed25519");
  const request = await fetch(e.origin + "/api/admin/pair/request", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: "Test client",
      publicKey: keys.publicKey.export({ format: "pem", type: "spki" }),
    }),
  });
  const pair = (await request.json()) as any;
  assert.equal(request.status, 201);
  await post(e, "pair/approve", { id: pair.id }, session);
  const poll = () =>
    fetch(e.origin + "/api/admin/pair/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(pair),
    });
  const registration = (await (await poll()).json()) as any;
  assert.ok(registration.deviceId);
  assert.equal((await poll()).status, 410);
  const connect = async () => {
    const ws = new WebSocket(e.origin.replace("http:", "ws:") + "/connect");
    const challenge = JSON.parse(String((await once(ws, "message"))[0]));
    ws.send(
      JSON.stringify({
        v: 1,
        type: "authenticate",
        deviceId: registration.deviceId,
        signature: sign(
          null,
          Buffer.from(`ido:1:${registration.deviceId}:${challenge.challenge}`),
          keys.privateKey,
        ).toString("base64"),
      }),
    );
    const ready = JSON.parse(String((await once(ws, "message"))[0]));
    return { ws, generation: ready.generation };
  };
  const first = await connect(),
    second = await connect();
  assert.equal(second.generation, first.generation + 1);
  assert.equal(e.peers.size, 1);
  const closed = once(second.ws, "close");
  await post(e, "devices/revoke", { deviceId: registration.deviceId }, session);
  await closed;
  assert.equal(
    e.store.get<Device>("device", registration.deviceId)?.revoked,
    true,
  );
});
test("durable allocation, capacity/permission filtering, deduplication and stale results", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ido-scheduler-"));
  let s = new Store(dir);
  t.after(async () => {
    s.close();
    await rm(dir, { recursive: true, force: true });
  });
  const user = s.createUser("member", "test-password-long", "member");
  s.put("project", "project", { id: "project", name: "Demo", remote: "" });
  const device = (
    id: string,
    slots: number,
    lastAssigned: number,
    network: boolean,
  ): Device => ({
    id,
    name: id,
    userId: user.id,
    publicKey: "test",
    generation: 1,
    revoked: false,
    grants: [{ projectId: "project", network, slots }],
    slots,
    lastAssigned,
  });
  s.put("device", "a", device("a", 2, 100, false));
  s.put("device", "b", device("b", 1, 0, true));
  const create = (requestId: string, network = false) =>
    new Tasks(s).createTask({
      projectId: "project",
      meetingId: "meeting",
      authorId: user.id,
      text: "build",
      requestId,
      network,
    });
  const first = create("first");
  assert.equal(create("first").id, first.id);
  const network = create("network", true);
  const third = create("third");
  new Scheduler(s).schedule(new Set(["a", "b"]));
  assert.equal(s.get<Task>("task", first.id)?.clientId, "a");
  assert.equal(s.get<Task>("task", network.id)?.clientId, "b");
  assert.equal(s.get<Task>("task", third.id)?.clientId, "a");
  assert.equal(s.pending("a").length, 2);
  const command = {
    v: 1 as const,
    type: "result",
    taskId: first.id,
    runId: first.runId,
    revision: 1,
    state: "completed",
    result: "done",
  };
  assert.equal(new Tasks(s).updateResult("a", 0, command), false);
  assert.equal(new Tasks(s).updateResult("b", 1, command), false);
  assert.equal(
    new Tasks(s).updateResult("a", 1, { ...command, runId: "stale" }),
    false,
  );
  s.close();
  s = new Store(dir);
  new Scheduler(s).schedule(new Set(["b"]));
  assert.equal(s.get<Task>("task", first.id)?.clientId, "a");
  assert.equal(s.pending("a").length, 2);
  assert.equal(new Tasks(s).updateResult("a", 1, command), true);
  assert.equal(new Tasks(s).updateResult("a", 1, command), false);
  new Tasks(s).control(first.id, user.id, "retry");
  assert.equal(s.get<Task>("task", first.id)?.revision, 2);
  assert.equal(new Tasks(s).updateResult("a", 1, command), false);
});
test("failed plugin installation preserves the active installation", async (t) => {
  const e = await fixture(t);
  e.store.put("plugin", "discord", {
    version: "previous",
    directory: "/not-executed",
  });
  await assert.rejects(e.plugins.install("discord", "unlisted"));
  assert.equal(e.store.get<any>("plugin", "discord").version, "previous");
});

test("one public HTTPS origin serves management and preview; public setup validates HTTPS", async (t) => {
  const engine = await fixture(t),
    session = await login(engine);
  assert.equal(
    (
      await post(
        engine,
        "public",
        { provider: "ngrok", engineUrl: "https://ido.example.com" },
        session,
      )
    ).status,
    200,
  );
  assert.deepEqual(engine.config(), {
    provider: "ngrok",
    engineUrl: "https://ido.example.com",
  });
  assert.equal(
    (
      await post(
        engine,
        "public",
        { provider: "manual", engineUrl: "http://127.0.0.1:9999" },
        session,
      )
    ).status,
    400,
  );
  assert.equal((await fetch(engine.origin + "/preview/")).status, 410);
  const result = await post(
    engine,
    "tunnels/start",
    { provider: "ngrok" },
    session,
  );
  assert.equal(result.status, 400);
  assert.equal(
    ((await result.json()) as any).error,
    "TUNNEL_CREDENTIAL_REQUIRED",
  );
});
