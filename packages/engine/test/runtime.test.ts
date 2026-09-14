import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { once } from "node:events";
import { WebSocket } from "ws";
import { request } from "node:http";
import { Engine } from "../src/index.js";
import { Store, type Device } from "../src/store.js";
import type { Task } from "../../common/src/protocol.js";

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
  const res = await fetch(engine.origin + "/api/login", {
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
  return fetch(engine.origin + "/api/" + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie: session.cookie,
      "x-csrf-token": session.csrf,
    },
    body: JSON.stringify(data),
  });
}
test("only administrators can read Engine diagnostics", async (t) => {
  const e = await fixture(t);
  const entry = e.store.logError(new Error("OPENAI_KEY_REQUIRED"), {
    source: "discord-voice",
    operation: "audio.transcribe",
    eventId: "private-event",
  });
  assert.equal((await fetch(e.origin + "/api/state")).status, 401);
  for (const role of ["admin", "member", "viewer"] as const) {
    if (role !== "admin") e.store.createUser(role, "test-password-long", role);
    const session = await login(e, role);
    const response = await fetch(e.origin + "/api/state", {
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
  const res = await fetch(e.origin + "/api/state", {
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
      await fetch(e.origin + "/api/state", {
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
  assert.equal((await fetch(e.origin + "/api/state")).status, 401);
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
      await fetch(e.origin + "/api/state", {
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
  const request = await fetch(e.origin + "/api/pair/request", {
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
    fetch(e.origin + "/api/pair/poll", {
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
    s.createTask({
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
  s.schedule(new Set(["a", "b"]));
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
  assert.equal(s.updateResult("a", 0, command), false);
  assert.equal(s.updateResult("b", 1, command), false);
  assert.equal(s.updateResult("a", 1, { ...command, runId: "stale" }), false);
  s.close();
  s = new Store(dir);
  s.schedule(new Set(["b"]));
  assert.equal(s.get<Task>("task", first.id)?.clientId, "a");
  assert.equal(s.pending("a").length, 2);
  assert.equal(s.updateResult("a", 1, command), true);
  assert.equal(s.updateResult("a", 1, command), false);
  s.control(first.id, user.id, "retry");
  assert.equal(s.get<Task>("task", first.id)?.revision, 2);
  assert.equal(s.updateResult("a", 1, command), false);
});
test("failed plugin installation preserves the active installation", async (t) => {
  const e = await fixture(t);
  e.store.put("plugin", "discord", {
    version: "previous",
    directory: "/not-executed",
  });
  await assert.rejects(e.plugins.install("unlisted"));
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

test("Discord linking from localhost uses the configured public callback, with local fallback", async (t) => {
  const engine = await fixture(t),
    session = await login(engine);
  engine.store.put("config", "discord", { appId: "123456789" });
  const local = await post(engine, "discord/link", {}, session);
  const localUrl = new URL(((await local.json()) as any).url);
  assert.equal(
    localUrl.searchParams.get("redirect_uri"),
    engine.origin + "/api/discord/callback",
  );
  engine.store.put("config", "public", {
    provider: "ngrok",
    engineUrl: "https://ido.example.com",
  });
  const remote = await post(engine, "discord/link", {}, session);
  assert.equal(remote.status, 200);
  const remoteUrl = new URL(((await remote.json()) as any).url);
  assert.equal(
    remoteUrl.searchParams.get("redirect_uri"),
    "https://ido.example.com/api/discord/callback",
  );
  assert.equal(remoteUrl.searchParams.get("client_id"), "123456789");
});

test("OAuth callback reports stopped Discord plugin without exposing authorization material", async (t) => {
  const engine = await fixture(t);
  engine.store.put("config", "discord", { appId: "123456789" });
  await engine.credentials.set(
    "discord.clientSecret",
    "synthetic-client-secret",
  );
  const user = engine.store.users()[0];
  const url = new URL(engine.discordAuth.start(user.id, engine.origin));
  const callback = new URL("/api/discord/callback", engine.origin);
  callback.search = new URLSearchParams({
    state: url.searchParams.get("state")!,
    code: "synthetic-code",
  }).toString();
  const response = await fetch(callback);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "DISCORD_PLUGIN_NOT_RUNNING",
  });
});

test("voice inputs follow the active plugin channel and reject obsolete configured channels after leave", async (t) => {
  const engine = await fixture(t);
  const user = engine.store.users()[0];
  engine.store.put("config", "discord", {
    guildId: "guild",
    textChannelId: "text",
    voiceChannelId: "old",
    meetingId: "meeting",
    projectId: "project",
  });
  engine.store.put("discord-user", "123456789", { userId: user.id });
  let processed = 0;
  engine.conversation.transcribe = async () => "synthetic transcript";
  engine.conversation.process = async () => {
    processed++;
    return { id: "meeting", name: "Test", summary: "Summary", messages: [] };
  };
  engine.conversation.speak = async () => "";
  const event = {
    guildId: "guild",
    userId: "123456789",
    audio: Buffer.from("synthetic").toString("base64"),
  };
  await engine.pluginInput({ ...event, channelId: "old", eventId: "old" });
  assert.equal(processed, 0);
  engine.plugins.voiceChannelId = "active";
  await engine.pluginInput({
    ...event,
    channelId: "active",
    eventId: "joined",
  });
  assert.equal(processed, 1);
  engine.plugins.stop();
  await engine.pluginInput({ ...event, channelId: "active", eventId: "left" });
  assert.equal(processed, 1);
});

test("Discord user policy defaults to all, validates IDs, persists changes and is admin-only", async (t) => {
  const e = await fixture(t),
    session = await login(e);
  const discord = {
    guildId: "123",
    textChannelId: "456",
    projectId: "project",
    meetingId: "meeting",
  };
  assert.equal((await post(e, "settings", { discord }, session)).status, 200);
  assert.equal(e.store.get<any>("config", "discord").userPolicy, "all");
  let updated: any;
  e.plugins.updatePolicy = (config) => {
    updated = config;
  };
  assert.equal(
    (
      await post(
        e,
        "settings",
        {
          discord: {
            ...discord,
            userPolicy: "allowlist",
            allowedUserIds: "100, 200\n100",
          },
        },
        session,
      )
    ).status,
    200,
  );
  assert.equal(updated.allowedUserIds, "100\n200");
  assert.equal(
    (
      await post(
        e,
        "settings",
        { discord: { ...discord, allowedUserIds: "not-an-id" } },
        session,
      )
    ).status,
    400,
  );
  assert.equal(e.store.get<any>("config", "discord").userPolicy, "allowlist");
  e.store.createUser("member", "test-password-long", "member");
  assert.equal(
    (await post(e, "settings", { discord }, await login(e, "member"))).status,
    403,
  );
});
