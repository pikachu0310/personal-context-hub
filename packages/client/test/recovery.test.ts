import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Command, Task } from "@ido/common/contracts/protocol";
import { run } from "@ido/common/runtime/platform";
import { Executor } from "../src/execution/executor.js";
test("a restarted Client does not re-execute a persisted delivery", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-recovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events: Command[] = [];
  const first = new Executor(directory, (m) => events.push(m));
  await first.load();
  const task: Task = {
    id: "task",
    runId: "run",
    revision: 1,
    state: "assigned",
    projectId: "p",
    meetingId: "m",
    authorId: "u",
    text: "build",
    requestId: "request",
    network: false,
    createdAt: 1,
    updatedAt: 1,
    history: [],
  };
  first.runs.run = {
    task,
    directory: join(directory, "preserved"),
    state: "running",
  };
  first.commands.push("command");
  await first.save();
  const restarted = new Executor(directory, (m) => events.push(m));
  await restarted.load();
  assert.equal(restarted.runs.run.state, "interrupted");
  let executions = 0;
  restarted.execute = async () => {
    executions++;
  };
  await restarted.receive(
    {
      v: 1,
      type: "execute",
      id: "command",
      taskId: "task",
      runId: "run",
      task,
    },
    [{ projectId: "p", directory, network: false, slots: 1 }],
    true,
    1,
  );
  assert.equal(executions, 0);
  assert.equal(events.at(-1)?.state, "interrupted");
  assert.equal(restarted.runs.run.directory, join(directory, "preserved"));
});
test("worktree artifact includes new text files and excludes credential files", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-artifact-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await run("git", ["init", directory]);
  await writeFile(join(directory, "app.txt"), "before\n");
  await writeFile(join(directory, ".env"), "FAKE_TEST_SECRET=before\n");
  await run("git", ["-C", directory, "add", "app.txt", ".env"]);
  await run("git", [
    "-C",
    directory,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "fixture",
  ]);
  await writeFile(join(directory, "app.txt"), "after\n");
  await writeFile(join(directory, ".env"), "FAKE_TEST_SECRET=after\n");
  await writeFile(join(directory, "new.txt"), "new content\n");
  const executor = new Executor(directory, () => {});
  executor.runs.run = {
    task: { revision: 1 } as Task,
    directory,
    state: "completed",
  };
  const artifact = await executor.artifact("run");
  assert.match(artifact.patch, /new content/);
  assert.match(artifact.patch, /after/);
  assert.ok(!artifact.patch.includes("FAKE_TEST_SECRET"));
});
