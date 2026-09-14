import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../../client/src/bootstrap/client.js";
import { Engine } from "../src/bootstrap/engine.js";
import { HttpError } from "@ido/common/runtime/http";
async function until(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("TIMEOUT");
}
test("member Client creates and maps idempotently, broadcasts, retries unknown results and checks current rights", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ido-client-project-"));
  const engine = new Engine({
    directory: join(dir, "engine"),
    port: 0,
    previewPort: 0,
  });
  engine.credentials.backend = "file";
  const user = engine.store.createUser(
    "member",
    "test-password-long",
    "member",
  );
  await engine.listen();
  const clients: Client[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await engine.close();
    await rm(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 2; i++) {
    const c = new Client(join(dir, `client${i}`));
    c.credentials.backend = "file";
    await c.start(0);
    clients.push(c);
    engine.store.put("device", `device${i}`, {
      id: `device${i}`,
      userId: user.id,
      name: "test",
      publicKey: c.settings.publicKey,
      revoked: false,
      generation: 0,
      slots: 1,
      lastAssigned: 0,
      grants: [],
    });
    c.settings.deviceId = `device${i}`;
    c.settings.engineUrl = engine.origin;
    await c.connect();
  }
  await until(() => clients.every((c) => c.connected));
  const c = clients[0];
  const post = async (name: string, directory: string) =>
    fetch(c.origin + "/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": c.csrf },
      body: JSON.stringify({ name, directory }),
    });
  const path = join(dir, "new");
  await mkdir(path);
  assert.equal((await post("First", path)).status, 200);
  await until(() =>
    clients[1].settings.projects.some((p) => p.name === "First"),
  );
  const project = c.settings.projects.find((p) => p.name === "First")!;
  assert.equal(
    c.settings.mappings.find((m) => m.projectId === project.id)?.network,
    false,
  );
  assert.equal(c.allow, false);
  assert.deepEqual(
    engine.store.get<any>("device", c.settings.deviceId!).grants,
    [],
  );
  assert.equal(
    engine.store.list<any>("project").some((p) => "directory" in p),
    false,
  );
  assert.equal((await post("First", path)).status, 409);
  const create = c.createProject;
  const retryPath = join(dir, "retry");
  await mkdir(retryPath);
  const uncertain = t.mock.method(
    c,
    "createProject",
    async (name: string, requestId?: string) => {
      await create(name, requestId);
      throw new HttpError(409, "PROJECT_DELIVERY_UNKNOWN");
    },
  );
  assert.equal((await post("Retry", retryPath)).status, 409);
  assert.ok(c.settings.pendingProject);
  const requestId = c.settings.pendingProject!.requestId;
  uncertain.mock.restore();
  assert.equal((await post("Retry", retryPath)).status, 200);
  assert.equal(c.settings.pendingProject, undefined);
  assert.equal(
    engine.store.list<any>("project").filter((p) => p.name === "Retry").length,
    1,
  );
  const replay = await c.createProject("Retry", requestId);
  assert.equal(replay.name, "Retry");
  engine.store.db
    .prepare("UPDATE users SET role='viewer' WHERE id=?")
    .run(user.id);
  await assert.rejects(
    c.createProject("Denied", "new-request"),
    /PERMISSION_DENIED/,
  );
  engine.store.db
    .prepare("UPDATE users SET role='member' WHERE id=?")
    .run(user.id);
  c.generation -= 1;
  const stale = c.createProject("Stale", "stale-request");
  await assert.rejects(stale, /PROJECT_DELIVERY_UNKNOWN/);
  assert.equal(
    engine.store
      .list<any>("project")
      .some((p) => p.name === "Stale" || p.name === "Denied"),
    false,
  );
});
