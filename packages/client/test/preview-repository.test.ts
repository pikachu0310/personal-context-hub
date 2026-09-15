import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  git,
  inspectImplementation,
  PreviewRepository,
  type Git,
} from "../src/preview/repository.js";
import type { Implementation } from "@ido/common/contracts/api";
test("published commits are fetched into isolated worktrees and survive branch movement", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ido-preview-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source"),
    remote = join(root, "remote.git");
  await mkdir(source);
  await git(["init", "-b", "main", source]);
  await git(["init", "--bare", remote]);
  const local = (...args: string[]) => git(["-C", source, ...args]);
  await local("config", "user.name", "Fixture");
  await local("config", "user.email", "fixture@example.invalid");
  const commit = async (body: string) => {
    await writeFile(join(source, "index.html"), body);
    await local("add", ".");
    await local("-c", "commit.gpgsign=false", "commit", "-m", body);
    return local("rev-parse", "HEAD");
  };
  const first = await commit("first");
  await local("remote", "add", "origin", "https://example.com/team/repo.git");
  await local("push", remote, "HEAD:refs/heads/main");
  // Replace only transport, retaining real Git object, fetch, worktree and dirty checks.
  const execute: Git = (args, signal) =>
    git(
      args.map((a) => (a === "https://example.com/team/repo.git" ? remote : a)),
      signal,
    );
  assert.equal(
    (await inspectImplementation(source, execute)).availability,
    "ready",
  );
  const second = await commit("second");
  assert.equal(
    (await inspectImplementation(source, execute)).availability,
    "unpushed",
  );
  await local("push", remote, "HEAD:refs/heads/main");
  const repository = new PreviewRepository(join(root, "cache"), execute);
  const artifact = (id: string, sha: string): Implementation => ({
    id,
    taskId: id,
    runId: id,
    revision: 1,
    projectId: "p",
    title: id,
    remote: "https://example.com/team/repo.git",
    branch: "refs/heads/main",
    commit: sha,
    createdAt: 1,
  });
  const a = join(root, "worktrees", "a"),
    b = join(root, "worktrees", "b");
  await Promise.all([
    repository.prepare(artifact("a", first), a),
    repository.prepare(artifact("b", second), b),
  ]);
  assert.equal(await readFile(join(a, "index.html"), "utf8"), "first");
  assert.equal(await readFile(join(b, "index.html"), "utf8"), "second");
  assert.equal(await local("symbolic-ref", "--short", "HEAD"), "main");
  await repository.prepare(artifact("a", first), a);
  await writeFile(join(source, "index.html"), "uncommitted");
  assert.equal(
    (await inspectImplementation(source, execute)).availability,
    "uncommitted",
  );
  await writeFile(join(a, "index.html"), "changed");
  await assert.rejects(
    repository.prepare(artifact("a", first), a),
    /PREVIEW_WORKTREE_CHANGED/,
  );
  await assert.rejects(
    repository.prepare(
      artifact("missing", "f".repeat(40)),
      join(root, "missing"),
    ),
    /GIT_FETCH_FAILED/,
  );
});
