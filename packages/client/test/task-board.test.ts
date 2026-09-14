import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Executor, type Run } from "../src/execution/executor.js";
import { TaskBoardConnection } from "../src/connection/task-board.js";
import { watchTaskBoard } from "../src/execution/task-board.mjs";
import type { Task, Command } from "@ido/common/contracts/protocol";

const task = (): Task => ({
  id: "task",
  runId: "run",
  revision: 1,
  state: "assigned",
  projectId: "project",
  meetingId: "meeting",
  authorId: "owner",
  text: "調査する",
  requestId: "request",
  network: false,
  createdAt: 1,
  updatedAt: 1,
  history: [],
  executionPolicy: { sandboxMode: "read-only" },
});

test("Codex receives board tools for new engine work and retains them on resume without granting them to local tasks", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-client-board-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options: any[] = [],
    prompts: string[] = [];
  const factory = () =>
    ({
      startThread: (input: any) => makeThread(input),
      resumeThread: (_id: string, input: any) => makeThread(input),
      close: async () => {},
    }) as any;
  const makeThread = (input: any) => {
    options.push(input);
    return {
      id: "thread",
      runStreamed: async (prompt: string) => {
        prompts.push(prompt);
        if (input.onToolCall) {
          const result = await input.onToolCall({
            tool: "board_post",
            arguments: { body: "相談" },
            callId: "call",
            threadId: "thread",
            turnId: "turn",
          });
          assert.equal(result.id, 1);
        }
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: "thread" };
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "調査結果" },
            };
            yield { type: "turn.completed" };
          })(),
        };
      },
    };
  };
  const first = new Executor(
    directory,
    (frame: Command) => {
      if (frame.type === "board.request")
        first.board.receive({
          ...frame,
          type: "board.result",
          result: { id: 1 },
        });
    },
    factory,
  );
  await first.load();
  first.board.supported = true;
  first.contextProfile = () => ({
    name: "Test user",
    context: "Include a reproducible verification procedure.",
  });
  const value: Run = { task: task(), directory, state: "assigned" };
  first.runs.run = value;
  const mapping = { projectId: "project", directory, network: false, slots: 1 };
  await first.execute(value, mapping, false);
  const restarted = new Executor(
    directory,
    (frame: Command) => {
      if (frame.type === "board.request")
        restarted.board.receive({
          ...frame,
          type: "board.result",
          result: { id: 1 },
        });
    },
    factory,
  );
  await restarted.load();
  restarted.board.supported = true;
  await restarted.execute(restarted.runs.run, mapping, false);
  assert.ok(
    options.slice(0, 2).every((input) => input.dynamicTools.length === 2),
  );
  assert.match(prompts[0], /自由な掲示板/);
  for (const prompt of prompts.slice(0, 2)) {
    assert.match(prompt, /参考コンテキスト/);
    assert.match(prompt, /Include a reproducible verification procedure\./);
    assert.match(prompt, /自由な掲示板/);
  }
  await restarted.receive(
    {
      v: 1,
      id: "retry-board-task",
      type: "retry",
      taskId: value.task.id,
      runId: value.task.runId,
      task: { ...value.task, revision: 2 },
    },
    [mapping],
    true,
    1,
  );
  await restarted.running.get(value.task.runId);
  assert.equal(restarted.runs.run.state, "completed");
  assert.equal(options.at(-1).dynamicTools?.length, 2);
  await restarted.execute(
    { task: task(), directory, state: "assigned", origin: "local" },
    mapping,
    false,
  );
  assert.equal(options.at(-1).dynamicTools, undefined);
  await restarted.execute(
    { task: task(), directory, state: "assigned", threadId: "legacy" },
    mapping,
    false,
  );
  assert.equal(options.at(-1).dynamicTools, undefined);
  assert.equal(first.board.listeners.size, 0);
  await first.close();
  await restarted.close();
});

test("board requests reject on disconnection and notices coalesce without peer text or idle wakeups", async () => {
  const sent: Command[] = [];
  const connection = new TaskBoardConnection((frame) => sent.push(frame));
  connection.supported = true;
  const controller = new AbortController();
  const board = connection.forTask(task(), controller.signal);
  let notices = 0;
  const stop = watchTaskBoard(
    board,
    {
      steer: async (text: string) => {
        notices++;
        assert.doesNotMatch(text, /private payload/);
      },
    },
    { delayMs: 2 },
  );
  connection.receive({
    v: 1,
    type: "board.changed",
    taskId: "task",
    runId: "run",
    revision: 1,
    body: "private payload",
  });
  connection.receive({
    v: 1,
    type: "board.changed",
    taskId: "task",
    runId: "run",
    revision: 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(notices, 1);
  const pending = board.read({});
  connection.receive({
    ...sent[0],
    type: "board.result",
    runId: "wrong",
    result: {},
  });
  assert.equal(connection.pending.size, 1);
  connection.close();
  await assert.rejects(pending, /CONNECTION_CLOSED/);
  assert.equal(connection.pending.size, 0);
  stop();
  assert.equal(connection.listeners.size, 0);
  controller.abort();
  await assert.rejects(board.post({ body: "ended" }, "key"));
});
