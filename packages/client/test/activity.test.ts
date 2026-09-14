import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@ido/common/contracts/protocol";
import { Executor, type Run } from "../src/execution/executor.js";
import { recordActivity, recordEvent } from "../src/execution/activity.js";

export const task = (): Task => ({
  id: "task",
  runId: "run",
  revision: 1,
  specRevision: 1,
  state: "assigned",
  projectId: "project",
  meetingId: "meeting",
  authorId: "user",
  requestId: "request",
  text: "調査して計画を提案",
  network: false,
  createdAt: 1,
  updatedAt: 1,
  history: [],
  executionPolicy: { sandboxMode: "read-only", networkAccessEnabled: false },
});
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("TEST_TIMEOUT");
}
test("activity retains item identity, masks credentials, bounds history, and stays local across restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-activity-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const frames: unknown[] = [];
  const executor = new Executor(directory, (data) => frames.push(data));
  const value: Run = { task: task(), directory, state: "running" };
  executor.runs.run = value;
  recordEvent(value, {
    type: "item.started",
    item: {
      id: "cmd",
      type: "command_execution",
      command: "git status",
      status: "in_progress",
    },
  });
  recordEvent(value, {
    type: "item.completed",
    item: {
      id: "cmd",
      type: "command_execution",
      command: "git status",
      aggregated_output: "clean\nAPI_KEY=fixture-sensitive-value",
      exit_code: 0,
      status: "completed",
    },
  });
  assert.equal(value.activity?.length, 1);
  assert.equal(value.activity?.[0].exitCode, 0);
  assert.ok(
    !JSON.stringify(value.activity).includes("fixture-sensitive-value"),
  );
  executor.report(value);
  assert.ok(!JSON.stringify(frames).includes("git status"));
  assert.ok(!JSON.stringify(frames).includes("activity"));
  for (let i = 0; i < 400; i++)
    recordActivity(value, {
      kind: "message",
      title: "Message",
      text: "x".repeat(20000),
    });
  assert.ok(JSON.stringify(value.activity).length <= 256000);
  assert.ok((value.activityDropped ?? 0) > 0);
  recordActivity(value, {
    kind: "message",
    title: "作業メモ",
    text: "最後の確認",
  });
  await executor.save();
  const restored = new Executor(directory, () => {});
  await restored.load();
  assert.equal(restored.runs.run.state, "interrupted");
  assert.ok(
    restored.runs.run.activity?.some((entry) => entry.text === "最後の確認"),
  );
});

test("Manual discusses twice, waits for explicit execute, keeps policy and allows mid-turn instructions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-manual-"));
  const turns: { prompt: string; options: any }[] = [];
  const policies: any[] = [],
    steers: string[] = [],
    frames: any[] = [];
  let releaseExecution: (() => void) | undefined;
  const thread = {
    activeTurnId: null as string | null,
    steer: async (text: string) => {
      steers.push(text);
      return true;
    },
    runStreamed: async (prompt: string, options: any) => ({
      events: (async function* () {
        turns.push({ prompt, options });
        thread.activeTurnId = "turn";
        yield { type: "thread.started", thread_id: "manual-thread" };
        yield { type: "turn.started" };
        yield {
          type: "item.completed",
          item: {
            id: `message-${turns.length}`,
            type: "agent_message",
            text:
              options.collaborationMode === "plan"
                ? "提案した計画"
                : "実行結果",
            phase:
              options.collaborationMode === "plan" ? "plan" : "final_answer",
          },
        };
        if (options.collaborationMode === "default")
          await new Promise<void>((resolve) => {
            releaseExecution = resolve;
          });
        thread.activeTurnId = null;
        yield { type: "turn.completed" };
      })(),
    }),
  };
  const executor = new Executor(
    directory,
    (data) => frames.push(data),
    () =>
      ({
        startThread: (options: any) => {
          policies.push(options);
          return thread;
        },
        close: async () => {
          releaseExecution?.();
        },
      }) as any,
  );
  t.after(async () => {
    await executor.close();
    await rm(directory, { recursive: true, force: true });
  });
  const value: Run = {
    task: task(),
    directory,
    state: "assigned",
    progressMode: "manual",
  };
  executor.runs.run = value;
  const mapping = { projectId: "project", directory, slots: 1, network: false };
  const job = executor.execute(value, mapping, false);
  executor.running.set("run", job);
  await until(() => executor.planWaiters.has("run"));
  assert.equal(value.state, "running");
  assert.equal(value.result, undefined);
  assert.equal(turns.length, 1);
  assert.ok(!frames.some((frame) => frame.state === "completed"));
  await executor.receive(
    {
      v: 1,
      type: "steer",
      id: "discussion",
      runId: "run",
      taskId: "task",
      revision: 1,
      specRevision: 2,
      text: "まず失敗ケースも考えて",
    },
    [mapping],
    true,
    1,
  );
  await until(() => turns.length === 2 && executor.planWaiters.has("run"));
  assert.match(turns[1].prompt, /失敗ケース/);
  assert.equal(turns[1].options.collaborationMode, "plan");
  await executor.startPlannedWork("run");
  await until(() => !!releaseExecution);
  assert.equal(turns[2].options.collaborationMode, "default");
  await executor.receive(
    {
      v: 1,
      type: "steer",
      id: "live",
      runId: "run",
      taskId: "task",
      revision: 1,
      specRevision: 3,
      text: "今の作業では公開しないで",
      sender: { id: "teammate", name: "Teammate" },
      sentAt: 12345,
    },
    [mapping],
    true,
    1,
  );
  assert.deepEqual(steers, ["今の作業では公開しないで"]);
  const instruction = value.activity?.find(
    (entry) => entry.id === "1:instruction:live",
  );
  assert.equal(instruction?.sentAt, 12345);
  assert.equal(instruction?.sender?.name, "Teammate");
  assert.equal(instruction?.status, "accepted");
  await executor.save();
  const restored = new Executor(directory, () => {});
  await restored.load();
  const savedInstruction = restored.runs.run.activity?.find(
    (entry) => entry.id === instruction?.id,
  );
  assert.equal(savedInstruction?.sentAt, 12345);
  assert.equal(savedInstruction?.sender?.id, "teammate");
  releaseExecution!();
  await job;
  assert.equal(value.state, "completed");
  assert.equal(value.result, "実行結果");
  assert.equal(value.activeSpecRevision, 3);
  assert.equal(policies.length, 1);
  assert.equal(policies[0].sandboxMode, "read-only");
  assert.equal(policies[0].approvalPolicy, "on-request");
  assert.equal(policies[0].networkAccessEnabled, false);
  assert.ok(
    value.activity?.some(
      (entry) =>
        entry.kind === "instruction" &&
        entry.text === "今の作業では公開しないで",
    ),
  );
});

test("stopping Manual while awaiting the plan releases the worker without executing", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-manual-stop-"));
  let calls = 0;
  const executor = new Executor(
    directory,
    () => {},
    () =>
      ({
        startThread: () => ({
          runStreamed: async () => ({
            events: (async function* () {
              calls++;
              yield {
                type: "item.completed",
                item: { type: "agent_message", phase: "plan", text: "計画" },
              };
              yield { type: "turn.completed" };
            })(),
          }),
        }),
        close: async () => {},
      }) as any,
  );
  t.after(async () => {
    await executor.close();
    await rm(directory, { recursive: true, force: true });
  });
  const value: Run = {
    task: task(),
    directory,
    state: "assigned",
    progressMode: "manual",
  };
  executor.runs.run = value;
  const mapping = { projectId: "project", directory, slots: 1, network: false };
  const job = executor.execute(value, mapping, false).catch(() => {});
  executor.running.set("run", job);
  await until(() => executor.planWaiters.has("run"));
  await executor.receive(
    { v: 1, type: "stop", id: "stop", taskId: "task", runId: "run" },
    [mapping],
    true,
    1,
  );
  await job;
  assert.equal(value.state, "cancelled");
  assert.equal(calls, 1);
  assert.equal(executor.planWaiters.size, 0);
  await assert.rejects(executor.startPlannedWork("run"), /PLAN_NOT_READY/);
});
