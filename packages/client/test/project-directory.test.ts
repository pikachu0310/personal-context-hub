import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "@ido/common/runtime/platform";
import { projectDirectory } from "../src/execution/project-directory.js";
test("empty directories get an empty initial commit; existing files are never automatically committed", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "ido-new-project-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const empty = join(dir, "empty");
  await mkdir(empty);
  const path = await projectDirectory(empty);
  assert.equal(
    await run("git", ["-C", path, "ls-tree", "-r", "--name-only", "HEAD"]),
    "",
  );
  const head = await run("git", ["-C", path, "rev-parse", "HEAD"]);
  await projectDirectory(empty);
  assert.equal(await run("git", ["-C", path, "rev-parse", "HEAD"]), head);
  await writeFile(join(empty, "uncommitted.txt"), "keep me");
  await projectDirectory(empty);
  assert.equal(
    await run("git", ["-C", path, "ls-tree", "-r", "--name-only", "HEAD"]),
    "",
  );
  const nonGit = join(dir, "files");
  await mkdir(nonGit);
  await writeFile(join(nonGit, "user.txt"), "private");
  await assert.rejects(
    projectDirectory(nonGit),
    /PROJECT_DIRECTORY_REQUIRES_EMPTY_OR_COMMITTED_REPO/,
  );
  assert.deepEqual(await readdir(nonGit), ["user.txt"]);
  const unborn = join(dir, "unborn");
  await mkdir(unborn);
  await run("git", ["init", unborn]);
  await assert.rejects(
    projectDirectory(unborn),
    /PROJECT_DIRECTORY_REQUIRES_EMPTY_OR_COMMITTED_REPO/,
  );
});
