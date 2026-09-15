import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "../src/bootstrap/client.js";
import type { Run } from "../src/execution/executor.js";
import { HttpError } from "@ido/common/runtime/http";
test("changing stopped local run permissions preserves sandbox networking and cannot mutate active work", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-run-access-"));
  const client = new Client(directory);
  client.credentials.backend = "file";
  t.mock.method(client, "checkAccount", async () => {});
  t.after(async () => {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  });
  await client.start(0);
  const run = {
    origin: "local",
    state: "running",
    accessMode: "sandbox",
    directory,
    task: {
      id: "r",
      runId: "r",
      projectId: "p",
      network: false,
      executionPolicy: { sandboxMode: "read-only" },
    },
    localMapping: { projectId: "p", directory, network: false, slots: 1 },
  } as Run;
  client.executor.runs.r = run;
  const post = (accessMode: string) =>
    fetch(`${client.origin}/api/access-mode`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": client.csrf,
      },
      body: JSON.stringify({ runId: "r", accessMode }),
    });
  assert.equal((await post("full")).status, 409);
  assert.equal(run.accessMode, "sandbox");
  run.state = "failed";
  assert.equal((await post("sandbox")).status, 200);
  assert.equal(run.task.network, false);
  assert.equal(run.localMapping?.network, false);
  const before = structuredClone(run);
  const saving = t.mock.method(client.executor, "save", async () => {
    throw new HttpError(500, "TEST_SAVE_FAILED");
  });
  assert.equal((await post("full")).status, 500);
  assert.deepEqual(run, before);
  saving.mock.restore();
  assert.equal((await post("full")).status, 200);
  assert.equal(run.accessMode, "full");
  assert.equal(run.task.executionPolicy, undefined);
  assert.equal(run.task.network, true);
});
