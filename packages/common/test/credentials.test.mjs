import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Credentials } from "@ido/common/runtime/credentials";

test("default credentials use secrets.json and preserve multiline values and owner-only permissions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-secrets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const credentials = new Credentials(directory, "test");
  assert.equal(credentials.backend, "file");
  await credentials.set("key", "line1\nline2\n");
  assert.equal(await credentials.get("key"), "line1\nline2\n");
  assert.equal(
    await new Credentials(directory, "test").get("key"),
    "line1\nline2\n",
  );
  if (process.platform !== "win32")
    assert.equal(
      (await stat(join(directory, "secrets.json"))).mode & 0o777,
      0o600,
    );
});
