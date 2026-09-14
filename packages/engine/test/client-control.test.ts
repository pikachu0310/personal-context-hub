import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Client } from "../../client/src/bootstrap/client.js";
import type { Run } from "../../client/src/execution/executor.js";
import { recordActivity } from "../../client/src/execution/activity.js";
import { Engine } from "../src/bootstrap/engine.js";
import type { Device } from "../src/domain/models.js";
import type { Task } from "@ido/common/contracts/protocol";
async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("CONDITION_TIMEOUT");
}
test("desktop controls are authenticated, restricted to the owning device, idempotent and CSRF protected", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-desktop-control-"));
  const engine = new Engine({
    directory: join(directory, "engine"),
    port: 0,
    previewPort: 0,
  });
  engine.credentials.backend = "file";
  const user = engine.store.createUser(
    "member",
    "fixture-password-long",
    "member",
  );
  engine.store.put("project", "project", {
    id: "project",
    name: "Demo",
    remote: "",
  });
  const client = new Client(join(directory, "client"));
  client.credentials.backend = "file";
  t.after(async () => {
    await client.close();
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });
  await engine.listen();
  t.mock.method(client, "checkAccount", async () => {
    client.loginStatus = "authenticated";
  });
  await client.start(0);
  engine.store.put("device", "device", {
    id: "device",
    name: "Desktop",
    userId: user.id,
    publicKey: client.settings.publicKey,
    revoked: false,
    generation: 0,
    slots: 1,
    lastAssigned: 0,
    grants: [],
  });
  client.settings.deviceId = "device";
  engine.store.put("project-member", "project:device", {
    projectId: "project",
    deviceId: "device",
  });
  client.settings.engineUrl = engine.origin;
  client.settings.mappings = [
    { projectId: "project", directory, slots: 1, network: false },
  ];
  client.allowedProjects.add("project");
  client.executor.execute = async (run: Run) => {
    run.state = "running";
    client.executor.report(run);
  };
  await client.connect();
  await until(() => engine.ready.size === 1);
  const task = engine.tasks.createTask({
    projectId: "project",
    meetingId: "meeting",
    authorId: user.id,
    text: "Synthetic task",
    requestId: "task-request",
    network: false,
  });
  engine.flush();
  await until(() => client.executor.runs[task.runId]?.state === "running");
  assert.equal(client.controlSupported, true);
  const post = (path: string, input: unknown, csrf = client.csrf) =>
    fetch(client.origin + "/api/" + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: client.origin,
        "x-csrf-token": csrf,
      },
      body: JSON.stringify(input),
    });
  const input = {
    runId: task.runId,
    requestKey: "request-one",
    instruction: "追加で境界を確認",
  };
  assert.equal((await post("instruction", input, "invalid")).status, 403);
  const first = await post("instruction", input);
  assert.equal(first.status, 200);
  const receipt = (await first.json()).receipt;
  const second = await post("instruction", input);
  assert.equal((await second.json()).receipt.id, receipt.id);
  await until(
    () => (client.executor.runs[task.runId].instructions?.length ?? 0) === 1,
  );
  assert.equal(engine.store.get<Task>("task", task.id)?.specRevision, 2);
  const run = client.executor.runs[task.runId];
  recordActivity(run, {
    kind: "message",
    title: "作業メモ",
    text: "local-only-message",
  });
  const state = await (await fetch(client.origin + "/api/state")).json();
  assert.ok(!JSON.stringify(state).includes("local-only-message"));
  const activity = await fetch(
    client.origin + `/api/activity?runId=${task.runId}`,
  );
  assert.match(await activity.text(), /local-only-message/);
  const foreignRead = await fetch(
    client.origin + `/api/activity?runId=${task.runId}`,
    { headers: { origin: "https://foreign.example" } },
  );
  assert.equal(foreignRead.status, 403);
  const before = structuredClone(client.settings.mappings);
  assert.equal(
    (await post("progress-mode", { projectId: "project", mode: "manual" }))
      .status,
    200,
  );
  assert.equal(client.settings.mappings[0].progressMode, "manual");
  assert.deepEqual(
    client.settings.mappings.map(({ progressMode, ...mapping }) => mapping),
    before,
  );
  assert.equal(client.allow, true);
  const authoritative = engine.store.get<Task>("task", task.id)!;
  authoritative.clientId = "other-device";
  engine.store.put("task", task.id, authoritative);
  const denied = await post("instruction", {
    ...input,
    requestKey: "request-two",
  });
  assert.equal(denied.status, 409);
  assert.equal((await denied.json()).error, "TASK_NOT_OWNED_BY_DEVICE");
  authoritative.clientId = "device";
  engine.store.put("task", task.id, authoritative);
  engine.store.remove("project-member", "project:device");
  const deniedRole = await post("instruction", {
    ...input,
    requestKey: "request-three",
  });
  assert.equal(deniedRole.status, 409);
  assert.equal((await deniedRole.json()).error, "CONTROL_REJECTED");
  assert.equal(engine.store.get<Device>("device", "device")?.revoked, false);
});
