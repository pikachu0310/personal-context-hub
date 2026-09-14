import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { control, lifetime } from "../src/runtime/lifecycle.js";

test("a failed shutdown retains ownership and a later quit retries worker settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ido-stop-retry-"));
  let calls = 0;
  const close = await lifetime(directory, async () => {
    calls++;
    if (calls === 1) throw new Error("WORKER_NOT_STOPPED");
  });
  try {
    await assert.rejects(close(), /WORKER_NOT_STOPPED/);
    assert.equal((await control(directory, "status")).running, true);
    await close();
    assert.equal(calls, 2);
    assert.equal((await control(directory, "status")).running, false);
  } finally {
    await close();
    await rm(directory, { recursive: true, force: true });
  }
});
