import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, Command } from "@ido/common/contracts/protocol";
import { Executor, type Run } from "../src/execution/executor.js";

const baseTask = (): Task => ({
  id: "task",
  runId: "run",
  revision: 1,
  specRevision: 1,
  state: "assigned",
  projectId: "project",
  meetingId: "meeting",
  authorId: "operator",
  text: "Read source",
  requestId: "request",
  network: true,
  createdAt: 1,
  updatedAt: 1,
  history: [],
  executionPolicy: { sandboxMode: "read-only", networkAccessEnabled: false },
});

test("Client applies explicit restrictions in the actual provider options and preserves them across resume", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-client-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options: any[] = [],
    prompts: string[] = [];
  const thread = {
    id: "thread",
    activeTurnId: "turn",
    steer: async () => true,
    runStreamed: async (prompt: string) => {
      prompts.push(prompt);
      return {
        events: (async function* () {
          yield { type: "thread.started", thread_id: "thread" };
          yield { type: "turn.started" };
          yield {
            type: "item.completed",
            item: {
              type: "agent_message",
              phase: "final_answer",
              text: "Evidence",
            },
          };
          yield { type: "turn.completed" };
        })(),
      };
    },
  };
  const factory = () =>
    ({
      startThread: (value: any) => {
        options.push(value);
        return thread;
      },
      resumeThread: (id: string, value: any) => {
        assert.equal(id, "thread");
        options.push(value);
        return thread;
      },
      close: async () => {},
    }) as any;
  const first = new Executor(directory, () => {}, factory);
  await first.load();
  const value: Run = {
    task: baseTask(),
    accessMode: "full",
    directory,
    state: "assigned",
    model: "test-codex-model",
  };
  first.runs.run = value;
  const mapping = { projectId: "project", directory, slots: 1, network: true };
  await first.execute(value, mapping, false);
  const restarted = new Executor(directory, () => {}, factory);
  await restarted.load();
  const next = restarted.runs.run;
  next.task.executionPolicy = {
    sandboxMode: "workspace-write",
    networkAccessEnabled: true,
  };
  await restarted.execute(next, mapping, false);
  for (const actual of options) {
    assert.equal(actual.model, "test-codex-model");
    assert.equal(actual.sandboxMode, "read-only");
    assert.equal(actual.requireWritableSandbox, false);
    assert.equal(actual.networkAccessEnabled, false);
  }
  assert.match(prompts[0], /読み取り専用/);
  const saved = JSON.parse(
    await readFile(join(directory, "runs.json"), "utf8"),
  );
  assert.equal(
    saved.runs.run.effectiveExecutionPolicy.sandboxMode,
    "read-only",
  );
});

test("ambiguous Client steering is durably uncertain, duplicates do not retry, and ordinary retry cannot replay it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-client-steer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const messages: Command[] = [];
  const executor = new Executor(directory, (message) => messages.push(message));
  await executor.load();
  const task = baseTask();
  const value: Run = {
    task,
    directory,
    state: "running",
    activeSpecRevision: 1,
  };
  executor.runs.run = value;
  let steers = 0;
  executor.active.set("run", {
    thread: {
      activeTurnId: "turn",
      steer: async () => {
        steers++;
        throw new Error("connection lost");
      },
    },
    codex: { close: async () => {} } as any,
    abort: new AbortController(),
  });
  const command: Command = {
    v: 1,
    type: "steer",
    id: "command",
    receiptId: "receipt",
    taskId: "task",
    runId: "run",
    revision: 1,
    specRevision: 2,
    controlVersion: 1,
    text: "Correction",
  };
  const mappings = [
    { projectId: "project", directory, network: true, slots: 1 },
  ];
  await executor.receive(command, mappings, true, 1);
  await executor.receive(command, mappings, true, 1);
  assert.equal(steers, 1);
  assert.equal(value.instructions?.[0].delivery, "uncertain");
  assert.equal(value.controlReceipts?.receipt.delivery, "uncertain");
  assert.equal(
    messages.find((message) => message.type === "result")?.specRevision,
    1,
  );
  const restored = new Executor(directory, () => {});
  await restored.load();
  let executions = 0;
  restored.execute = async () => {
    executions++;
  };
  const retry: Command = {
    v: 1,
    type: "retry",
    id: "retry",
    receiptId: "retry-receipt",
    controlVersion: 2,
    taskId: "task",
    runId: "run",
    revision: 2,
    task: { ...task, revision: 2, specRevision: 2 },
  };
  await restored.receive(retry, mappings, true, 1);
  assert.equal(executions, 0);
  assert.equal(restored.runs.run.state, "interrupted");
  await restored.receive(
    {
      ...retry,
      id: "resolved",
      receiptId: "resolved-receipt",
      controlVersion: 3,
      revision: 3,
      instructionResolution: "discard",
      task: { ...task, revision: 3, specRevision: 2 },
    },
    mappings,
    true,
    1,
  );
  assert.equal(executions, 1);
  assert.equal(restored.runs.run.instructions?.length, 0);
  assert.equal(restored.runs.run.controlReceipts?.receipt.delivery, "rejected");
});

test("stop receipt waits for provider and execution settlement and stale controls cannot stop a retried run", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-client-stop-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const events: Command[] = [];
  const executor = new Executor(directory, (event) => events.push(event));
  await executor.load();
  const task = { ...baseTask(), revision: 2 };
  const value: Run = { task, directory, state: "running" };
  executor.runs.run = value;
  let release!: () => void;
  executor.running.set(
    "run",
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );
  let closed = false;
  let notifyClosed!: () => void;
  const closeStarted = new Promise<void>((resolve) => {
    notifyClosed = resolve;
  });
  const controller = new AbortController();
  executor.active.set("run", {
    thread: {},
    abort: controller,
    codex: {
      close: async () => {
        closed = true;
        notifyClosed();
      },
    } as any,
  });
  const mappings = [
    { projectId: "project", directory, network: true, slots: 1 },
  ];
  await executor.receive(
    {
      v: 1,
      type: "stop",
      id: "stale",
      taskId: task.id,
      runId: task.runId,
      revision: 1,
    },
    mappings,
    true,
    1,
  );
  assert.equal(controller.signal.aborted, false);
  const stopping = executor.receive(
    {
      v: 1,
      type: "stop",
      id: "stop",
      receiptId: "receipt",
      controlVersion: 1,
      taskId: task.id,
      runId: task.runId,
      revision: 2,
    },
    mappings,
    true,
    1,
  );
  await closeStarted;
  assert.equal(closed, true);
  assert.equal(value.controlReceipts?.receipt.delivery, "pending");
  assert.equal(
    events.some((event) => event.id === "stop" && event.type === "ack"),
    false,
  );
  release();
  await stopping;
  assert.equal(value.controlReceipts?.receipt.delivery, "stopped");
  assert.equal(controller.signal.aborted, true);
});

test("Client does not report successful completion for missing terminal events or commentary-only output", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-client-incomplete-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const terminal of [false, true]) {
    const output: Command[] = [];
    const factory = () =>
      ({
        startThread: () => ({
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "item.completed",
                item: {
                  type: "agent_message",
                  phase: terminal ? "commentary" : "final_answer",
                  text: "partial",
                },
              };
              if (terminal) yield { type: "turn.completed" };
            })(),
          }),
        }),
        close: async () => {},
      }) as any;
    const executor = new Executor(
      directory,
      (event) => output.push(event),
      factory,
    );
    const value: Run = { task: baseTask(), directory, state: "assigned" };
    await executor.load();
    executor.runs.run = value;
    await assert.rejects(
      executor.execute(
        value,
        { projectId: "project", directory, network: false, slots: 1 },
        false,
      ),
      /CODEX_TASK_INCOMPLETE/,
    );
    assert.equal(
      output.some((event) => event.state === "completed"),
      false,
    );
  }
});

test("local access survives restart and controls actual runtime approval and sandbox", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-access-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const accessMode of ["sandbox", "full", "approval"] as const) {
    for (const network of [false, true]) {
      const captured: any[] = [];
      const factory = () =>
        ({
          startThread(options: any) {
            captured.push(options);
            return {
              runStreamed: async () => ({
                events: (async function* () {
                  yield {
                    type: "item.completed",
                    item: {
                      type: "agent_message",
                      phase: "final_answer",
                      text: "done",
                    },
                  };
                  yield {
                    type: "item.completed",
                    item: {
                      type: "agent_message",
                      phase: "final_answer",
                      text: "done",
                    },
                  };
                  yield { type: "turn.completed" };
                })(),
              }),
            };
          },
          close: async () => {},
        }) as any;
      const executor = new Executor(
        join(directory, `${accessMode}-${network}`),
        () => {},
        factory,
      );
      await executor.load();
      const task = baseTask();
      task.executionPolicy = undefined;
      const value: Run = {
        task,
        directory,
        state: "assigned",
        origin: "local",
        accessMode,
        progressMode: "manual",
        planApproved: true,
      };
      executor.runs.run = value;
      await executor.execute(
        value,
        { projectId: "project", directory, slots: 1, network },
        false,
      );
      const restored = new Executor(
        join(directory, `${accessMode}-${network}`),
        () => {},
        factory,
      );
      await restored.load();
      assert.equal(restored.runs.run.accessMode, accessMode);
      await restored.execute(
        restored.runs.run,
        { projectId: "project", directory, slots: 1, network },
        false,
      );
      assert.equal(captured.length, 2);
      for (const options of captured) {
        assert.equal(
          options.sandboxMode,
          accessMode === "sandbox" ? "workspace-write" : "danger-full-access",
        );
        assert.equal(
          options.approvalPolicy,
          accessMode === "full"
            ? "never"
            : accessMode === "approval"
              ? "untrusted"
              : "on-request",
        );
        assert.equal(
          options.networkAccessEnabled,
          accessMode === "sandbox" ? network : true,
        );
        assert.equal(options.requireWritableSandbox, accessMode === "sandbox");
      }
    }
  }
});

test("direct project work preserves the editor checkout on first execution and resume", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-direct-project-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd: string[] = [];
  const thread = {
    runStreamed: async () => ({
      events: (async function* () {
        yield { type: "thread.started", thread_id: "direct-thread" };
        yield {
          type: "item.completed",
          item: { type: "agent_message", text: "Done" },
        };
        yield { type: "turn.completed" };
      })(),
    }),
  };
  const factory = () =>
    ({
      startThread: (options: any) => {
        cwd.push(options.workingDirectory);
        return thread;
      },
      resumeThread: (_id: string, options: any) => {
        cwd.push(options.workingDirectory);
        return thread;
      },
      close: async () => {},
    }) as any;
  const executor = new Executor(directory, () => {}, factory);
  await executor.load();
  const mapping = {
    projectId: "project",
    directory,
    slots: 1,
    network: true,
    workspaceMode: "project" as const,
  };
  const task = { ...baseTask(), model: "test-codex-model" };
  await executor.receive(
    {
      v: 1,
      type: "execute",
      id: "direct-start",
      taskId: task.id,
      runId: task.runId,
      task,
    },
    [mapping],
    true,
    1,
  );
  await executor.running.get(task.runId);
  assert.equal(executor.runs.run.state, "completed");
  assert.equal(cwd[0], directory);
  // This directory deliberately has no Git repository: attempting worktree add
  // would fail before the provider starts.
  assert.equal(executor.runs.run.workspaceMode, "project");
  const restarted = new Executor(directory, () => {}, factory);
  await restarted.load();
  const next = { ...task, revision: 2 };
  await restarted.receive(
    {
      v: 1,
      type: "retry",
      id: "direct-resume",
      taskId: task.id,
      runId: task.runId,
      task: next,
    },
    [{ ...mapping, workspaceMode: "worktree" }],
    true,
    1,
  );
  await restarted.running.get(task.runId);
  assert.equal(restarted.runs.run.state, "completed");
  assert.deepEqual(cwd, [directory, directory]);
});

test("direct project admission serializes two projects sharing the same checkout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-direct-exclusive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executor = new Executor(directory, () => {});
  await executor.load();
  executor.execute = async () => {};
  const mapping = {
    projectId: "project",
    directory,
    slots: 8,
    network: true,
    workspaceMode: "project" as const,
  };
  const first = baseTask();
  const second = {
    ...baseTask(),
    id: "second",
    runId: "second",
    projectId: "other",
  };
  const mappings = [mapping, { ...mapping, projectId: "other" }];
  const send = (task: Task) =>
    executor.receive(
      {
        v: 1,
        type: "execute",
        id: task.id,
        taskId: task.id,
        runId: task.runId,
        task,
      },
      mappings,
      true,
      8,
    );
  await send(first);
  await send(second);
  assert.equal(executor.runs.second, undefined);
  assert.equal(executor.commands.includes(second.id), false);
  executor.runs.run.state = "completed";
  await send(second);
  const accepted = executor.runs.second as Run | undefined;
  assert.equal(accepted?.directory, directory);
});

test("client admission caps legacy eight-slot settings at four across projects", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-four-slots-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executor = new Executor(directory, () => {});
  await executor.load();
  executor.execute = async () => {};
  const mappings = ["project", "other"].map((projectId) => ({
    projectId,
    directory,
    slots: 8,
    network: true,
  }));
  const send = (index: number) => {
    const task = {
      ...baseTask(),
      id: `task-${index}`,
      runId: `run-${index}`,
      projectId: index % 2 ? "other" : "project",
    };
    return executor.receive(
      {
        v: 1,
        type: "execute",
        id: task.id,
        taskId: task.id,
        runId: task.runId,
        task,
      },
      mappings,
      true,
      8,
    );
  };
  for (let index = 0; index < 5; index++) await send(index);
  assert.equal(Object.keys(executor.runs).length, 4);
  assert.equal(executor.runs["run-4"], undefined);
  executor.runs["run-0"].state = "completed";
  await send(4);
  assert.equal((executor.runs["run-4"] as Run | undefined)?.state, "assigned");
});
