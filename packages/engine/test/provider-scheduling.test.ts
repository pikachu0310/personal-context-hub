import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/adapters/sqlite/store.js";
import { Tasks } from "../src/processing/tasks/service.js";
import { Scheduler } from "../src/clients/scheduler.js";
import type { Device } from "../src/domain/models.js";
import type { Task } from "@ido/common/contracts/protocol";
test("scheduler preserves requested provider/model/mode and waits for an authenticated capable worker", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-provider-test-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.put("project", "p", { id: "p", name: "Fixture" });
  const task = new Tasks(store).createTask({
    projectId: "p",
    meetingId: "m",
    authorId: "user",
    requestId: "r",
    text: "Test",
    network: false,
    agent: "claude",
    model: "sonnet",
    reasoningEffort: "high",
    progressMode: "manual",
  });
  const device = {
    id: "pc",
    codexConnected: true,
    slots: 2,
    grants: [{ projectId: "p", network: true, slots: 2 }],
    profile: { name: "PC", claudeConnected: true },
    lastAssigned: 0,
  } as Device;
  const scheduler = new Scheduler(store);
  const save = () => store.put("device", device.id, device);
  save();
  scheduler.schedule(new Set([device.id]));
  assert.equal(store.get<Task>("task", task.id)?.state, "queued");
  device.profile!.taskOptionsVersion = 1;
  save();
  scheduler.schedule(new Set([device.id]));
  assert.equal(store.get<Task>("task", task.id)?.state, "queued");
  device.grants[0].agents = ["claude"];
  device.codexConnected = false;
  save();
  scheduler.schedule(new Set([device.id]));
  const assigned = store.get<Task>("task", task.id)!;
  assert.equal(assigned.clientId, device.id);
  assert.equal(assigned.agent, "claude");
  assert.equal(assigned.model, "sonnet");
  assert.equal(assigned.reasoningEffort, "high");
  assert.equal(assigned.progressMode, "manual");
  assert.equal((store.pending(device.id)[0].task as Task).model, "sonnet");
});
