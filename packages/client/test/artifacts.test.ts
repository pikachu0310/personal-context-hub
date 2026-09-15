import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listArtifacts, readArtifact } from "../src/preview/artifacts.js";
import { Client } from "../src/bootstrap/client.js";
import type { Run } from "../src/execution/executor.js";

test("artifact reads stay inside the work directory and are bounded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ido-artifact-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const work = join(root, "work");
  await mkdir(work);
  await writeFile(join(work, "index.html"), "<button>試す</button>");
  await writeFile(join(root, "private.html"), "private");
  await writeFile(join(work, ".secret.html"), "secret");
  await writeFile(join(work, "huge.html"), "x".repeat(2 * 1024 * 1024 + 1));
  await symlink(join(root, "private.html"), join(work, "escape.html"));
  await symlink(root, join(work, "outside"), "dir");
  assert.deepEqual(
    (await listArtifacts(work)).map((a) => a.path),
    ["index.html"],
  );
  assert.equal(
    (await readArtifact(work, "index.html")).html,
    "<button>試す</button>",
  );
  for (const path of [
    "../private.html",
    join(root, "private.html"),
    ".secret.html",
    "escape.html",
    "outside/private.html",
    "huge.html",
  ])
    await assert.rejects(readArtifact(work, path));
});

test("artifact HTTP document enforces sandbox and deleted/foreign run boundaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ido-artifact-http-"));
  const client = new Client(join(root, "client"));
  t.after(async () => {
    await client.close();
    await rm(root, { recursive: true, force: true });
  });
  await writeFile(
    join(root, "index.html"),
    "<script>document.body.textContent='active'</script>",
  );
  await client.start(0);
  client.executor.runs.run = {
    directory: root,
    origin: "local",
    state: "completed",
    task: { id: "task", runId: "run", projectId: "project" },
  } as Run;
  const url = `${client.origin}/api/artifact-document?runId=run&path=index.html`;
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const csp = response.headers.get("content-security-policy")!;
  assert.match(csp, /sandbox allow-scripts/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-top-navigation/);
  assert.match(csp, /connect-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    (await fetch(url, { headers: { Origin: "https://outside.invalid" } }))
      .status,
    403,
  );
  client.executor.runs.run.origin = undefined;
  assert.equal((await fetch(url)).status, 404);
  client.executor.runs.run.origin = "local";
  client.executor.deletedTasks.task = {
    taskId: "task",
    deletedAt: Date.now(),
  } as never;
  assert.equal((await fetch(url)).status, 404);
});
