import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Engine } from "../src/index.js";
import { Client } from "../../client/src/index.js";
import type { Run } from "../../client/src/executor.js";
import type { Task } from "../../common/src/protocol.js";
async function until(check: () => boolean) {
  for (let n = 0; n < 100; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("CONDITION_TIMEOUT");
}
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
    c.settings.engineUrl = e.origin;
    c.settings.mappings = [
      { projectId: "project", directory, network: false, slots: 1 },
    ];
    c.allow = true;
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
    e.store.createTask({
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
