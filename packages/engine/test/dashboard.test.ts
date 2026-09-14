import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import type { Task, Command } from "@ido/common/contracts/protocol";
import type { DashboardState } from "@ido/common/contracts/api";
import { Engine } from "../src/bootstrap/engine.js";
import { dashboardSnapshot } from "../src/adapters/http/dashboard-query.js";
async function until(check: () => boolean) {
  for (let n = 0; n < 150; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("TIMEOUT");
}
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "ido-dashboard-"));
  const engine = new Engine({
    directory,
    port: 0,
    previewPort: 0,
    conversation: false,
  });
  engine.credentials.backend = "file";
  const user = engine.store.createUser("admin", "test-password-long", "admin");
  await engine.listen();
  const session = engine.store.session(user.id);
  const request = (path: string, input?: unknown, auth = session) =>
    fetch(engine.origin + "/api/admin/dashboard" + path, {
      method: input ? "POST" : "GET",
      headers: {
        cookie: `ido_session=${auth.token}`,
        "content-type": "application/json",
        "x-csrf-token": auth.csrf,
      },
      body: input ? JSON.stringify(input) : undefined,
    });
  t.after(async () => {
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { engine, user, session, request };
}
async function connect(
  e: Engine,
  userId: string,
  deviceId = "device",
  keys = generateKeyPairSync("ed25519"),
) {
  if (!e.store.get("device", deviceId))
    e.store.put("device", deviceId, {
      id: deviceId,
      name: "Demo worker",
      userId,
      publicKey: keys.publicKey
        .export({ type: "spki", format: "pem" })
        .toString(),
      revoked: false,
      generation: 0,
      grants: [],
      slots: 1,
      lastAssigned: 0,
    });
  const ws = new WebSocket(e.origin.replace("http:", "ws:") + "/connect");
  const received: Command[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    received.push(m);
    if (m.type === "challenge")
      ws.send(
        JSON.stringify({
          v: 1,
          type: "authenticate",
          deviceId,
          profile: { name: "Demo", codexConnected: true },
          signature: sign(
            null,
            Buffer.from(`ido:1:${deviceId}:${m.challenge}`),
            keys.privateKey,
          ).toString("base64"),
        }),
      );
  });
  await until(() => received.some((m) => m.type === "authenticated"));
  const generation = Number(
    received.find((m) => m.type === "authenticated")!.generation,
  );
  const send = (value: object) =>
    ws.send(JSON.stringify({ v: 1, generation, ...value }));
  send({
    type: "ready",
    profile: { name: "Demo", codexConnected: true },
    grants: [{ projectId: "default", slots: 1, network: false }],
    slots: 1,
  });
  await until(() => e.ready.has(deviceId));
  return { ws, received, generation, send, keys };
}
function task(e: Engine, authorId: string, requestId = "request") {
  return e.tasks.createTask({
    projectId: "default",
    meetingId: e.store.list<{ meetingId: string }>("project-conversation")[0]
      .meetingId,
    authorId,
    text: "Review routing",
    title: "Routing task",
    requestId,
    network: false,
  });
}
const expected = (t: Task) => ({
  id: t.id,
  runId: t.runId,
  revision: t.revision,
  controlVersion: t.controlVersion ?? 0,
});

test("dashboard is admin-only, enforces CSRF and never changes a task on stale control", async (t) => {
  const { engine: e, user, request, session } = await fixture(t);
  assert.equal((await fetch(e.origin + "/api/admin/dashboard")).status, 401);
  for (const role of ["member", "viewer"] as const) {
    const u = e.store.createUser(role, "test-password-long", role),
      s = e.store.session(u.id);
    assert.equal((await request("", undefined, s)).status, 403);
    assert.equal((await request("/raw?kind=events", undefined, s)).status, 403);
    assert.equal((await request("/stop", { taskId: "any" }, s)).status, 403);
  }
  const work = task(e, user.id);
  const input = {
    taskId: work.id,
    runId: work.runId,
    revision: work.revision,
    controlVersion: 0,
    requestId: "stop-one",
  };
  assert.equal(
    (await request("/stop", input, { ...session, csrf: "invalid" })).status,
    403,
  );
  assert.equal((await request("/stop", { ...input, revision: 2 })).status, 409);
  assert.equal(e.store.get<Task>("task", work.id)?.state, "queued");
  const response = await request("/stop", input);
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as any).delivery, "stopped");
  assert.equal((await request("/stop", input)).status, 200);
  assert.equal(
    Object.values(e.store.get<Task>("task", work.id)?.controlReceipts ?? {})
      .length,
    1,
  );
  const wrongOrigin = await fetch(e.origin + "/api/admin/dashboard/stop", {
    method: "POST",
    headers: {
      origin: "https://untrusted.example",
      cookie: `ido_session=${session.token}`,
      "x-csrf-token": session.csrf,
    },
    body: JSON.stringify(input),
  });
  assert.equal(wrongOrigin.status, 403);
});

test("authoritative totals include long-running work, group devices by owner, and raw views are bounded and allowlisted", async (t) => {
  const { engine: e, user, request } = await fixture(t);
  const client = await connect(e, user.id);
  t.after(() => client.ws.terminate());
  const c2 = await connect(e, user.id, "device-two");
  t.after(() => c2.ws.terminate());
  const work = task(e, user.id);
  e.flush();
  await until(() => !!e.store.get<Task>("task", work.id)?.clientId);
  const live = e.store.get<Task>("task", work.id)!;
  live.state = "running";
  e.store.put("task", live.id, live);
  for (let i = 0; i < 1001; i++)
    e.store.put("task", `done-${i}`, {
      ...work,
      id: `done-${i}`,
      state: "completed",
    });
  e.store.put("config", "private", { password: "must-not-leak" });
  for (let i = 0; i < 62; i++)
    e.store.put("message", `m-${i}`, {
      id: `m-${i}`,
      meetingId: work.meetingId,
      authorId: user.id,
      text: "hello sk-private123456789",
      at: Date.now() - 1000,
      role: i === 0 ? "assistant" : "user",
      complete: i !== 1,
      stage: "completed",
      internal: "must-not-leak",
    });
  const state = (await (await request("")).json()) as DashboardState;
  assert.equal(state.counts.running, 1);
  assert.equal(state.counts.connectedUsers, 1);
  assert.equal(state.tasks.length, 1002);
  assert.equal(state.activity.total, 60);
  assert.ok(state.tasks.find((t) => t.id === live.id)?.assignmentReason);
  assert.equal(state.projects[0].userIds.length, 1);
  assert.ok(!JSON.stringify(state).includes("must-not-leak"));
  assert.ok(!JSON.stringify(state).includes("publicKey"));
  const raw = (await (await request("/raw?kind=messages")).json()) as any;
  assert.equal(raw.items.length, 50);
  assert.equal(raw.total, 62);
  assert.ok(!JSON.stringify(raw).includes("private123456789"));
  assert.ok(!JSON.stringify(raw).includes("internal"));
  const tail = (await (
    await request("/raw?kind=messages&offset=50")
  ).json()) as any;
  assert.equal(tail.items.length, 12);
  assert.ok(
    tail.items.every((i: any) => !raw.items.some((r: any) => r.id === i.id)),
  );
  assert.equal((await request("/raw?kind=secrets")).status, 400);
  assert.equal((await request("/raw?offset=-1")).status, 400);
  assert.equal((await request("/raw?from=invalid")).status, 400);
  assert.equal((await request("?projectId=missing")).status, 404);
});

test("stop remains pending until the worker confirms and retry does not duplicate delivery", async (t) => {
  const { engine: e, user, request } = await fixture(t),
    c = await connect(e, user.id);
  t.after(() => c.ws.terminate());
  const work = task(e, user.id);
  e.flush();
  await until(() => c.received.some((m) => m.type === "execute"));
  c.send({
    type: "result",
    taskId: work.id,
    runId: work.runId,
    revision: 1,
    state: "running",
  });
  await until(() => e.store.get<Task>("task", work.id)?.state === "running");
  const input = {
    taskId: work.id,
    runId: work.runId,
    revision: 1,
    controlVersion: 0,
    requestId: "stop-active",
  };
  const receipt = (await (await request("/stop", input)).json()) as any;
  assert.equal(receipt.delivery, "pending");
  assert.equal(e.store.get<Task>("task", work.id)?.state, "running");
  assert.equal(dashboardSnapshot(e, user).tasks[0].stop?.delivery, "pending");
  assert.equal((await request("/stop", input)).status, 200);
  c.send({
    type: "result",
    taskId: work.id,
    runId: work.runId,
    revision: 1,
    state: "cancelled",
    controlReceipts: [
      {
        id: receipt.id,
        controlVersion: receipt.controlVersion,
        delivery: "stopped",
      },
    ],
  });
  await until(
    () => dashboardSnapshot(e, user).tasks[0].stop?.delivery === "stopped",
  );
  const events = (await (
    await request(`/raw?kind=events&target=${work.id}`)
  ).json()) as any;
  assert.ok(
    events.items.some(
      (row: any) => JSON.parse(row.text).action === "task.stop.confirmed",
    ),
  );
  e.tasks.control(work.id, user.id, "retry", undefined, {
    requestKey: "resume-after-stop",
  });
  const resumed = dashboardSnapshot(e, user).tasks.find(
    (t) => t.id === work.id,
  )!;
  assert.equal(resumed.state, "assigned");
  assert.equal(
    resumed.stop,
    undefined,
    "a previous run's stop must not mask the retried task",
  );
});

test("disconnect stops only confirmed runs, preserves queued work and enrollment, and allows reconnection", async (t) => {
  const { engine: e, user, request } = await fixture(t),
    c = await connect(e, user.id);
  t.after(() => c.ws.terminate());
  const running = task(e, user.id, "one"),
    queued = task(e, user.id, "two");
  e.flush();
  const assigned = e.store.get<Task>("task", running.id)!;
  assert.equal(e.store.get<Task>("task", queued.id)?.state, "queued");
  const target = {
    deviceId: "device",
    generation: c.generation,
    tasks: [expected(assigned)],
  };
  assert.equal(
    (await request("/disconnect", { ...target, generation: c.generation - 1 }))
      .status,
    409,
  );
  assert.equal(
    (await request("/disconnect", { ...target, tasks: [] })).status,
    409,
  );
  c.ws.on("message", (raw) => {
    const cmd = JSON.parse(raw.toString());
    if (cmd.type === "stop")
      c.send({
        type: "result",
        taskId: running.id,
        runId: running.runId,
        revision: 1,
        state: "cancelled",
        controlReceipts: [
          {
            id: cmd.receiptId,
            controlVersion: cmd.controlVersion,
            delivery: "stopped",
          },
        ],
      });
  });
  const closed = once(c.ws, "close");
  const response = await request("/disconnect", target);
  assert.equal(response.status, 200);
  assert.deepEqual(((await response.json()) as any).unconfirmedTaskIds, []);
  assert.equal((await closed)[0], 4004);
  assert.equal(e.store.get<any>("device", "device").revoked, false);
  assert.ok(e.store.get("project-member", "default:device"));
  assert.equal(e.store.get<Task>("task", queued.id)?.state, "queued");
  const replacement = await connect(e, user.id, "device", c.keys);
  t.after(() => replacement.ws.terminate());
  assert.ok(replacement.generation > c.generation);
  assert.equal((await request("/disconnect", target)).status, 200);
  assert.equal(replacement.ws.readyState, WebSocket.OPEN);
});

test("an unresponsive worker is not reported stopped; replacement connection survives in-flight disconnect", async (t) => {
  const { engine: e, user, request } = await fixture(t),
    c = await connect(e, user.id);
  t.after(() => c.ws.terminate());
  const work = task(e, user.id);
  e.flush();
  const assigned = e.store.get<Task>("task", work.id)!;
  const pending = request("/disconnect", {
    deviceId: "device",
    generation: c.generation,
    tasks: [expected(assigned)],
  });
  await until(
    () => e.connections.sessions.get("device")?.disconnecting === true,
  );
  c.send({ type: "ready", grants: [], slots: 1 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(e.ready.has("device"), false);
  const replacement = await connect(e, user.id, "device", c.keys);
  t.after(() => replacement.ws.terminate());
  const result = (await (await pending).json()) as any;
  assert.deepEqual(result.unconfirmedTaskIds, [work.id]);
  assert.equal(replacement.ws.readyState, WebSocket.OPEN);
  assert.equal(e.ready.has("device"), true);
  assert.equal(e.store.get<Task>("task", work.id)?.state, "assigned");
});

test("disconnect timeout keeps stop unconfirmed and clears old execute replay", async (t) => {
  const { engine: e, user, request } = await fixture(t),
    c = await connect(e, user.id);
  t.after(() => c.ws.terminate());
  const work = task(e, user.id);
  e.flush();
  const assigned = e.store.get<Task>("task", work.id)!;
  const response = await request("/disconnect", {
    deviceId: "device",
    generation: c.generation,
    tasks: [expected(assigned)],
  });
  assert.equal(response.status, 200);
  assert.deepEqual(((await response.json()) as any).unconfirmedTaskIds, [
    work.id,
  ]);
  assert.equal(e.ready.has("device"), false);
  assert.equal(e.store.get<Task>("task", work.id)?.state, "assigned");
  assert.ok(e.store.pending("device").every((c) => c.type !== "execute"));
  assert.ok(
    e.store
      .events()
      .some((e) => e.action === "connection.disconnected.stop_unconfirmed"),
  );
});

test("dashboard lifecycle routes enforce admin, CSRF, confirmations and default project protection", async (t) => {
  const { engine: e, user, request, session } = await fixture(t);
  const p = { id: "lifecycle-project", name: "Lifecycle project", remote: "" };
  e.store.put("project", p.id, p);
  const input = {
    projectId: p.id,
    name: p.name,
    membershipVersion: 0,
    confirm: true,
  };
  const ordinary = e.store.createUser("ordinary", "fixture-password", "member");
  const ordinarySession = e.store.session(ordinary.id);
  for (const operation of ["project/invite", "project/delete", "task/delete"]) {
    assert.equal(
      (await request(`/${operation}`, input, ordinarySession)).status,
      403,
    );
    assert.equal(
      (await request(`/${operation}`, input, { ...session, csrf: "invalid" }))
        .status,
      403,
    );
  }
  const invite = await request("/project/invite", { projectId: p.id });
  assert.equal(invite.status, 200);
  assert.match((await invite.json()).url, /\/invite\//);
  assert.equal(
    (await request("/project/delete", { ...input, name: "wrong" })).status,
    400,
  );
  assert.ok(e.store.get("project", p.id));
  assert.equal(
    (
      await request("/project/delete", {
        ...input,
        projectId: "default",
        name: "デフォルト",
      })
    ).status,
    400,
  );
  const target = task(e, user.id);
  const removal = {
    taskId: target.id,
    revision: 1,
    controlVersion: 0,
    membershipVersion: 0,
    confirm: true,
  };
  assert.equal(
    (await request("/task/delete", { ...removal, confirm: false })).status,
    400,
  );
  assert.ok(e.store.get("task", target.id));
  assert.equal((await request("/task/delete", removal)).status, 200);
  assert.equal(e.store.get("task", target.id), undefined);
  assert.equal((await request("/project/delete", input)).status, 200);
  assert.equal(e.store.get("project", p.id), undefined);
});

test("dashboard and workspace report the bot project independently of the dashboard filter without exposing config", async (t) => {
  const { engine, user } = await fixture(t);
  const plugin = engine.plugins.get("discord");
  plugin.manifest = {
    id: "discord",
    version: "0.2.0",
    protocol: 2,
    title: "Discord Bot + Activity",
    fields: [],
    capabilities: ["project-conversation"],
  };
  engine.store.put("project", "other", {
    id: "other",
    name: "開発",
    remote: "",
  });
  engine.store.put("config", "discord", {
    projectId: "default",
    botToken: "test-only-secret",
    guildId: "test-guild",
  });
  const initial = dashboardSnapshot(engine, user);
  assert.equal(initial.conversationBindings?.[0].projectId, "default");
  engine.store.put("config", "discord", {
    projectId: "other",
    botToken: "test-only-secret",
  });
  const switched = dashboardSnapshot(engine, user, "default");
  assert.deepEqual(switched.conversationBindings, [
    {
      pluginId: "discord",
      title: "Discord Bot + Activity",
      projectId: "other",
      projectName: "開発",
    },
  ]);
  const workspace: any = await engine.workspace.request("state", {}, {
    actor: user,
    valid: () => true,
  } as any);
  assert.deepEqual(
    workspace.conversationBindings,
    switched.conversationBindings,
  );
  assert.doesNotMatch(
    JSON.stringify(switched.conversationBindings),
    /secret|guildId|botToken/,
  );
});
