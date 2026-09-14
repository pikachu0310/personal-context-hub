import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Engine } from "../packages/engine/dist/index.js";

const directory = await mkdtemp(join(tmpdir(), "ido-preview-browser-"));
const engine = new Engine({ directory, port: 0, previewPort: 0 });
const user = engine.store.createUser("admin", "test-password-long", "admin");
engine.credentials.backend = "file";
let browser;
const forwarded = [];
try {
  await engine.listen();
  clearInterval(engine.timer);
  engine.store.put("project", "project", {
    id: "project",
    name: "Preview test",
  });
  const task = engine.store.createTask({
    projectId: "project",
    meetingId: "meeting",
    authorId: user.id,
    text: "preview",
    requestId: "preview-test",
    network: false,
  });
  task.clientId = "device";
  task.state = "running";
  engine.store.put("task", task.id, task);
  engine.ready.add("device");
  engine.peers.set("device", {
    readyState: 1,
    ping() {},
    terminate() {},
    send(value) {
      const event = JSON.parse(value);
      forwarded.push(event);
      if (event.type === "preview.http") {
        const html =
          event.method === "POST"
            ? '<p id="received">Form received</p>'
            : `<!doctype html><meta charset="utf-8"><h1>Preview</h1>
          <form action="./" method="POST"><input name="message" value="hello"><button>Submit preview</button></form>
          <p id="socket">waiting</p><script>
          window.probe = {};
          try { parent.document.body; probe.parent = 'escaped'; } catch { probe.parent = 'blocked'; }
          try { localStorage.setItem('escape', '1'); probe.storage = 'escaped'; } catch { probe.storage = 'blocked'; }
          probe.api = fetch('/api/state', { credentials:'include' }).then(r => r.status).catch(() => 'blocked');
          probe.worker = Promise.resolve().then(() => navigator.serviceWorker.register('./worker.js')).then(() => 'escaped').catch(() => 'blocked');
          const url = new URL(location.href); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
          const socket = new WebSocket(url); socket.onopen = () => socket.send('echo works');
          socket.onmessage = e => document.querySelector('#socket').textContent = e.data;
          </script>`;
        queueMicrotask(() =>
          engine.preview.receive("device", {
            v: 1,
            type: "preview.http.result",
            requestId: event.requestId,
            status: 200,
            headers: { "content-type": "text/html", "set-cookie": "evil=1" },
            body: Buffer.from(html).toString("base64"),
          }),
        );
      } else if (event.type === "preview.ws.data") {
        queueMicrotask(() => engine.preview.receive("device", event));
      }
    },
  });
  engine.preview.register("device", {
    v: 1,
    type: "preview.register",
    previewId: "preview",
    taskId: task.id,
    runId: task.runId,
    revision: task.revision,
  });
  const ticket = engine.preview.ticket(task.id, user.id);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(engine.origin);
  await page.getByLabel("ユーザー名").fill("admin");
  await page.getByLabel("パスワード").fill("test-password-long");
  await page.getByRole("button", { name: "ログイン", exact: true }).click();
  await page
    .getByRole("heading", { name: "チームの状況", exact: true })
    .waitFor();
  await page.evaluate((path) => {
    const iframe = globalThis.document.createElement("iframe");
    iframe.style.cssText =
      "position:fixed;inset:0;width:100%;height:100%;z-index:99999;background:white";
    iframe.name = "test-preview";
    iframe.sandbox = "allow-scripts allow-forms";
    iframe.src = path;
    globalThis.document.body.append(iframe);
  }, ticket);
  const frame = page.frameLocator('iframe[name="test-preview"]');
  await frame.locator("#socket").getByText("echo works").waitFor();
  const child = page.frame({ name: "test-preview" });
  const probe = await child.evaluate(async () => ({
    parent: probe.parent,
    storage: probe.storage,
    api: await probe.api,
    worker: await probe.worker,
  }));
  assert.deepEqual(probe, {
    parent: "blocked",
    storage: "blocked",
    api: "blocked",
    worker: "blocked",
  });
  await frame.getByRole("button", { name: "Submit preview" }).click();
  await frame.locator("#received").waitFor();
  const form = forwarded.find(
    (event) => event.type === "preview.http" && event.method === "POST",
  );
  assert.equal(Buffer.from(form.body, "base64").toString(), "message=hello");
  assert.equal(form.headers.cookie, undefined);
  assert.equal(form.headers.authorization, undefined);
  assert.ok(
    !(await context.cookies()).some((cookie) => cookie.name === "evil"),
  );
  // Even a direct tab is sandboxed by response CSP (no reliance on the parent iframe).
  const direct = await context.newPage();
  await direct.goto(engine.origin + ticket);
  await direct.waitForFunction(() => Boolean(globalThis.probe));
  assert.equal(await direct.evaluate(() => probe.storage), "blocked");
  assert.equal(await direct.evaluate(() => probe.api), "blocked");
  console.log(
    "Preview browser smoke passed: same-host HTTP/form/WebSocket, opaque origin, blocked management access/storage/service workers, stripped credentials, direct-tab CSP.",
  );
} finally {
  await browser?.close();
  engine.peers.clear();
  await engine.close();
  await rm(directory, { recursive: true, force: true });
}
