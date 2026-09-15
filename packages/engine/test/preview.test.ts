import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { ClientPreview } from "../../client/src/preview/relay.js";
import { PreviewRelay } from "../src/adapters/client-ws/preview.js";
import { Engine } from "../src/bootstrap/engine.js";
import { Tasks } from "../src/processing/tasks/service.js";
test("registered previews relay HTTP, forms and WebSockets without management credentials; stale versions fail closed", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-preview-")),
    engine = new Engine({ directory, port: 0, previewPort: 0 }),
    store = engine.store;
  const user = store.createUser("member", "test-password-long", "member");
  store.put("project", "project", { id: "project", name: "Demo" });
  const task = new Tasks(store).createTask({
    projectId: "project",
    meetingId: "meeting",
    authorId: user.id,
    text: "build",
    requestId: "request",
    network: false,
  });
  task.clientId = "device";
  task.state = "running";
  store.put("task", task.id, task);
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader("content-type", "application/json");
    res.setHeader("set-cookie", "must-not-escape=1");
    res.end(
      JSON.stringify({
        path: req.url,
        method: req.method,
        body: Buffer.concat(chunks).toString(),
        cookie: req.headers.cookie,
        authorization: req.headers.authorization,
        prefix: req.headers["x-forwarded-prefix"],
      }),
    );
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws) => ws.on("message", (data) => ws.send(data)));
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address() as { port: number };
  let relay: PreviewRelay;
  const client = new ClientPreview((data) => relay.receive("device", data));
  client.register("preview", address.port);
  const connection = {
    readyState: WebSocket.OPEN,
    send: (value: string) => void client.receive(JSON.parse(value)),
  } as unknown as WebSocket;
  relay = engine.preview;
  engine.ready.add("device");
  engine.peers.set("device", connection);
  // The test uses a synthetic Client transport; all HTTP/WS traffic goes through Engine.
  await engine.listen();
  relay.register("device", {
    v: 1,
    type: "preview.register",
    previewId: "preview",
    taskId: task.id,
    runId: task.runId,
    revision: 1,
  });
  const origin = engine.origin;
  t.after(async () => {
    client.close();
    engine.peers.clear();
    await engine.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    upstream.closeAllConnections();
    await new Promise<void>((r) => upstream.close(() => r()));
    await rm(directory, { recursive: true, force: true });
  });
  const path = relay.ticket(task.id, user.id);
  const res = await fetch(origin + path + "form?q=yes", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      Cookie: "ido_session=must-not-forward",
      Authorization: "Bearer must-not-forward",
    },
    body: "answer=42",
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("set-cookie"), null);
  assert.match(
    res.headers.get("content-security-policy")!,
    /sandbox allow-scripts allow-forms/,
  );
  const data = (await res.json()) as any;
  assert.equal(data.body, "answer=42");
  assert.equal(data.path, "/form?q=yes");
  assert.equal(data.prefix, path);
  assert.equal(data.cookie, undefined);
  assert.equal(data.authorization, undefined);
  const ws = new WebSocket(origin.replace("http:", "ws:") + path + "socket", {
    headers: { Host: "engine.lan:4310" },
  });
  await once(ws, "open");
  ws.send("hello");
  const message = await once(ws, "message");
  assert.equal(String(message[0]), "hello");
  ws.close();
  assert.equal((await fetch(origin + "/api/admin/state")).status, 401);
  assert.equal(
    (
      await fetch(origin + "/api/admin/state", {
        headers: { Origin: "null", Cookie: "ido_session=must-not-forward" },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(origin + "/preview/api/state")).status, 410);
  assert.equal((await fetch(origin + "/preview/p/unknown/")).status, 410);
  task.revision = 2;
  store.put("task", task.id, task);
  assert.equal((await fetch(origin + path)).status, 410);
  engine.ready.delete("device");
  assert.throws(() => relay.ticket(task.id, user.id), /OFFLINE/);
});
