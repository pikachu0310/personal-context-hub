import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import type { Command, Task } from "@ido/common/contracts/protocol";
import { Executor } from "../src/execution/executor.js";

test("purge removes managed task histories and model logs across restart, preserves Git and other sessions, and rejects stale execution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-purge-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events: Command[] = [],
    executor = new Executor(directory, (m) => events.push(m));
  await executor.load();
  const task = {
    id: "task",
    runId: "run",
    revision: 1,
    text: "private instruction",
    state: "completed",
    history: [],
    projectId: "project",
  } as unknown as Task;
  const worktree = join(directory, "worktrees", "run");
  await mkdir(worktree, { recursive: true });
  await writeFile(join(worktree, "file.txt"), "preserved Git content");
  const sessions = join(executor.home, "sessions", "2026");
  await mkdir(sessions, { recursive: true });
  await writeFile(
    join(sessions, "rollout-thread.jsonl"),
    "private model context",
  );
  await writeFile(join(sessions, "rollout-other.jsonl"), "other session");
  const index = new DatabaseSync(join(executor.home, "state_5.sqlite"));
  index.exec(
    "CREATE TABLE threads(id TEXT PRIMARY KEY, initial_prompt TEXT); CREATE TABLE tools(thread_id TEXT REFERENCES threads(id), payload TEXT); INSERT INTO threads VALUES ('thread','private initial prompt'), ('other','other prompt'); INSERT INTO tools VALUES ('thread','private tool')",
  );
  executor.runs.run = {
    task,
    state: "completed",
    directory: worktree,
    threadId: "thread",
    result: "private result",
    activity: [
      {
        id: "a",
        kind: "message",
        title: "private activity",
        revision: 1,
        at: 1,
        updatedAt: 1,
      },
    ],
  };
  await executor.save();
  await executor.receive(
    { v: 1, type: "task.purge", id: "purge", taskId: task.id },
    [],
    false,
    0,
  );
  assert.deepEqual(
    index
      .prepare("SELECT id FROM threads")
      .all()
      .map((row) => row.id),
    ["other"],
  );
  assert.equal(index.prepare("SELECT count(*) AS n FROM tools").get()!.n, 0);
  index.close();
  assert.deepEqual(executor.runs, {});
  assert.equal(executor.deletedTasks.task, true);
  assert.deepEqual(executor.pendingPurges, {});
  assert.equal(events.at(-1)?.type, "ack");
  await assert.rejects(
    readFile(join(sessions, "rollout-thread.jsonl")),
    /ENOENT/,
  );
  assert.equal(
    await readFile(join(sessions, "rollout-other.jsonl"), "utf8"),
    "other session",
  );
  assert.equal(
    await readFile(join(worktree, "file.txt"), "utf8"),
    "preserved Git content",
  );
  assert.ok(
    !(await readFile(join(directory, "runs.json"), "utf8")).includes("private"),
  );
  const restarted = new Executor(directory, (m) => events.push(m));
  await restarted.load();
  let executed = false;
  restarted.execute = async () => {
    executed = true;
  };
  await restarted.receive(
    {
      v: 1,
      type: "retry",
      id: "stale",
      taskId: task.id,
      runId: task.runId,
      task,
    },
    [{ projectId: "project", directory: worktree, network: false, slots: 1 }],
    true,
    1,
  );
  assert.equal(executed, false);
  assert.deepEqual(restarted.runs, {});
});

test(
  "purge interrupts active work and declines approvals before waiting for execution to finish",
  { timeout: 5000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "ido-purge-active-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const events: Command[] = [];
    const executor = new Executor(directory, (event) => events.push(event));
    await executor.load();
    const task = {
      id: "active-task",
      runId: "active-run",
      revision: 1,
      text: "active",
      projectId: "project",
      state: "running",
      history: [],
    } as unknown as Task;
    const run = { task, state: "running" as const, directory, activity: [] };
    executor.runs[task.runId] = run;
    const abort = new AbortController();
    executor.active.set(task.runId, {
      abort,
      thread: undefined,
      codex: { close: async () => {} },
    });
    let resolveApproval!: (value: { decision: string }) => void;
    const approval = new Promise<{ decision: string }>((resolve) => {
      resolveApproval = resolve;
    });
    const timer = setTimeout(
      () => resolveApproval({ decision: "timeout" }),
      60000,
    );
    t.after(() => clearTimeout(timer));
    executor.approvals.set("approval", {
      runId: task.runId,
      method: "execute",
      params: {},
      timer,
      resolve: resolveApproval,
    });
    let finished = false;
    executor.running.set(
      task.runId,
      approval.then((value) => {
        assert.equal(abort.signal.aborted, true);
        assert.equal(value.decision, "decline");
        executor.report(run);
        finished = true;
      }),
    );
    await executor.receive(
      { v: 1, type: "task.purge", id: "purge-active", taskId: task.id },
      [],
      false,
      0,
    );
    assert.equal(finished, true);
    assert.equal(executor.approvals.size, 0);
    assert.equal(executor.runs[task.runId], undefined);
    assert.deepEqual(
      events.map((event) => event.type),
      ["ack"],
    );
    const restarted = new Executor(directory, () => {});
    await restarted.load();
    assert.equal(restarted.deletedTasks[task.id], true);
    assert.equal(restarted.runs[task.runId], undefined);
  },
);
