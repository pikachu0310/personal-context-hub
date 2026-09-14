import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { TaskWorkspaceManager } from "../src/execution/codex/workspace.mjs";
import { DiscordVoiceTaskQueue } from "../src/adapters/discord/sessions.mjs";
import { taskControls } from "../src/adapters/discord/commands.mjs";

const exec = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ido-apply-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "source");
  await mkdir(repo);
  const git = (...args) => exec("git", ["-C", repo, ...args]);
  await git("init");
  await writeFile(join(repo, "app.txt"), "initial\n");
  await git("add", "app.txt");
  await git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  );
  const manager = new TaskWorkspaceManager({
    repository: repo,
    directory: join(root, "workers"),
  });
  const task = { id: "work", runRevision: 1 };
  await manager.prepare(task);
  await writeFile(join(task.workingDirectory, "app.txt"), "first\n");
  await writeFile(join(task.workingDirectory, "new.txt"), "new first\n");
  task.artifacts = await manager.collect(task);
  return { root, repo, manager, task };
}

test("apply, continue, and apply again preserves a new file across development iterations", async (t) => {
  const { repo, manager, task } = await fixture(t);
  assert.equal(await manager.apply(task), true);
  task.runRevision = 2;
  await writeFile(join(task.workingDirectory, "app.txt"), "second\n");
  await writeFile(join(task.workingDirectory, "new.txt"), "new second\n");
  task.artifacts = await manager.collect(task);
  assert.equal(await manager.apply(task), true);
  assert.equal(await readFile(join(repo, "app.txt"), "utf8"), "second\n");
  assert.equal(await readFile(join(repo, "new.txt"), "utf8"), "new second\n");
  assert.equal(await manager.apply(task), false);
  task.runRevision = 3;
  task.artifacts = await manager.collect(task);
  assert.equal(task.artifacts.hasChanges, false);
  assert.equal(await readFile(task.artifacts.patchPath, "utf8"), "");
});

test("a modified saved patch cannot be applied as the reviewed artifact", async (t) => {
  const { repo, manager, task } = await fixture(t);
  const patch = await readFile(task.artifacts.patchPath, "utf8");
  await writeFile(
    task.artifacts.patchPath,
    patch.replace("+first", "+unexpected"),
  );
  await assert.rejects(manager.apply(task), /integrity|changed|hash/i);
  assert.equal(await readFile(join(repo, "app.txt"), "utf8"), "initial\n");
});

test("editing a previously applied new file prevents the next apply from overwriting it", async (t) => {
  const { repo, manager, task } = await fixture(t);
  await manager.apply(task);
  await writeFile(join(repo, "new.txt"), "user edit\n");
  task.runRevision = 2;
  await writeFile(join(task.workingDirectory, "new.txt"), "worker edit\n");
  task.artifacts = await manager.collect(task);
  await assert.rejects(manager.apply(task), /Source changed/);
  assert.equal(await readFile(join(repo, "new.txt"), "utf8"), "user edit\n");
});

test("restoring a task cannot accept an unrelated repository at the expected directory", async (t) => {
  const { root, repo } = await fixture(t);
  const directory = join(root, "other-workers");
  const target = join(directory, "work");
  await mkdir(target, { recursive: true });
  await exec("git", ["-C", target, "init"]);
  const manager = new TaskWorkspaceManager({ repository: repo, directory });
  await assert.rejects(
    manager.prepare({ id: "work", workingDirectory: target }),
    /repository|worktree/i,
  );
});

test("old Discord controls cannot apply a newer unreviewed revision", async (t) => {
  let applied = 0;
  const queue = new DiscordVoiceTaskQueue({
    logger: {},
    applyTask: async (task) => {
      applied++;
      task.applied = true;
      task.appliedRevision = task.artifacts.runRevision;
      return true;
    },
  });
  t.after(() => queue.stop());
  await queue.restore(
    [
      {
        id: "work",
        state: "completed",
        applied: true,
        appliedRevision: 1,
        artifacts: { runRevision: 2 },
      },
    ],
    async () => ({ threadId: "thread", update: async () => undefined }),
  );
  assert.equal(await queue.applyTask("work", 1), false);
  assert.equal(applied, 0);
  assert.equal(await queue.applyTask("work", 2), true);
  assert.equal(await queue.applyTask("work", 2), false);
  assert.equal(applied, 1);
  assert.equal(
    taskControls("work", "completed", 2)[0].components[2].custom_id,
    "ido:apply:work:2",
  );
  assert.equal(
    taskControls("work", "completed", 2, true)[0].components[2].disabled,
    true,
  );
});
