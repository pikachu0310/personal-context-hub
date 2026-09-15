import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Executor, type Run } from "../src/execution/executor.js";
import { TaskBoardConnection } from "../src/connection/task-board.js";
import { callTaskBoard, watchTaskBoard } from "../src/execution/task-board.mjs";
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

test("board reads normalize unused arguments before sending to older engines without dropping active filters", async () => {
  const inputs: unknown[] = [];
  const board = {
    read: async (input: unknown) => {
      inputs.push(input);
      return { threads: [] };
    },
  };
  const args = {
    taskId: null,
    query: "",
    limit: null,
    offset: null,
    id: null,
    after: null,
    replyTo: null,
    includeFinished: null,
  };
  const identity = { callId: "call", threadId: "thread", turnId: "turn" };
  const call = (input: unknown) =>
    callTaskBoard(board, { ...identity, tool: "board_read", arguments: input });
  await call(args);
  assert.deepEqual(inputs.pop(), {});
  assert.equal(args.query, "");
  const filtered = {
    taskId: "peer",
    query: "API",
    includeFinished: false,
    limit: 2,
    after: 0,
    offset: 0,
  };
  await call(filtered);
  assert.deepEqual(inputs.pop(), filtered);
  await call({ query: " \n\t" });
  assert.deepEqual(inputs.pop(), {});
  await call({ query: " ".repeat(201) });
  assert.deepEqual(inputs.pop(), { query: " ".repeat(201) });
  await assert.rejects(call(null), /arguments must be an object/);
  await assert.rejects(call([]), /arguments must be an object/);
  const error = new Error("BOARD_CONNECTION_CLOSED");
  let attempts = 0;
  await assert.rejects(
    callTaskBoard(
      {
        read: async () => {
          attempts++;
          throw error;
        },
      },
      { ...identity, tool: "board_read", arguments: filtered },
    ),
    error,
  );
  assert.equal(attempts, 1);
});

test("stopping during local sharing registration never starts the agent afterwards", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-stop-registration-"));
  let started = 0;
  const executor = new Executor(directory, () => {}, (() => {
    started++;
    throw new Error("MUST_NOT_START");
  }) as any);
  t.after(async () => {
    await executor.close();
    await rm(directory, { recursive: true, force: true });
  });
  await executor.load();
  let entered!: () => void, finish!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  executor.sharedTask = async (value) => {
    entered();
    await pending;
    return value.task;
  };
  const value: Run = {
    task: task(),
    directory,
    origin: "local",
    state: "assigned",
  };
  executor.runs.run = value;
  const executing = executor.execute(
    value,
    { projectId: "project", directory, network: false, slots: 1 },
    false,
  );
  await entering;
  value.state = "cancelled";
  finish();
  await executing;
  assert.equal(started, 0);
  assert.equal(executor.active.size, 0);
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

test("board requests reject on disconnection and notices coalesce without peer text or idle wakeups", async (t) => {
  const sent: Command[] = [];
  const connection = new TaskBoardConnection((frame) => sent.push(frame));
  connection.supported = true;
  const controller = new AbortController();
  const board = connection.forTask(task(), controller.signal);
  await assert.rejects(
    board.post({ scope: "project", body: "Discussion" }, "old-engine"),
    /ENGINE_UPDATE/,
  );
  assert.equal(sent.length, 0);
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
  t.after(() => {
    stop();
    controller.abort();
    connection.close();
  });
  for (const frame of sent)
    connection.receive({
      ...frame,
      type: "board.result",
      result: { posts: [] },
    });
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
    ...sent.at(-1)!,
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

test("meeting search and board tools coexist through restart and retry while old threads keep their tool set", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-combined-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options: any[] = [];
  const turns: any[] = [];
  let catalogCalls = 0;
  const factory = () =>
    ({
      request: async () => {
        catalogCalls++;
        return { data: [{ model: "gpt-5.6-sol" }] };
      },
      startThread: makeThread,
      resumeThread: (_id: string, input: any) => makeThread(input),
      close: async () => {},
    }) as any;
  function makeThread(input: any) {
    options.push(input);
    return {
      id: "thread",
      runStreamed: async (_prompt: string, turn: any) => {
        turns.push(turn);
        const params = { threadId: "thread", turnId: "turn", callId: "call" };
        if (
          input.dynamicTools?.some(
            (tool: any) => tool.name === "meeting_context_search",
          )
        ) {
          const page = await input.onToolCall({
            ...params,
            tool: "meeting_context_search",
            arguments: {},
          });
          assert.equal(page.documents[0].markdown, "# 手動編集");
        }
        if (
          input.dynamicTools?.some((tool: any) => tool.name === "board_post")
        ) {
          const post = await input.onToolCall({
            ...params,
            tool: "board_post",
            arguments: { body: "確認しました" },
          });
          assert.equal(post.id, 1);
        }
        return {
          events: (async function* () {
            yield { type: "thread.started", thread_id: "thread" };
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "完了" },
            };
            yield { type: "turn.completed" };
          })(),
        };
      },
    };
  }
  const makeExecutor = () => {
    const executor = new Executor(
      directory,
      (frame: Command) => {
        if (frame.type === "board.request")
          executor.board.receive({
            ...frame,
            type: "board.result",
            result: { id: 1 },
          });
      },
      factory,
    );
    executor.knowledge = async () => ({
      projectId: "project",
      topics: [],
      messages: [],
      total: 0,
      offset: 0,
      documents: [
        {
          meetingId: "meeting",
          meetingName: "会議",
          markdown: "# 手動編集",
          revision: 1,
          offset: 0,
        },
      ],
    });
    executor.board.supported = true;
    return executor;
  };
  const first = makeExecutor();
  await first.load();
  const value: Run = {
    task: task(),
    directory,
    state: "assigned",
    reasoningEffort: "high",
  };
  first.runs.run = value;
  const mapping = { projectId: "project", directory, network: false, slots: 1 };
  await first.execute(value, mapping, false);
  assert.equal(catalogCalls, 1);
  assert.equal(turns[0].reasoningEffort, "high");
  assert.equal(value.model, "gpt-5.6-sol");
  await first.close();
  const restarted = makeExecutor();
  await restarted.load();
  await restarted.execute(restarted.runs.run, mapping, false);
  await restarted.receive(
    {
      v: 1,
      id: "retry",
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
  assert.equal(catalogCalls, 1);
  assert.ok(
    options.slice(0, 3).every((input) => input.dynamicTools.length === 4),
  );
  for (const extra of [
    { threadId: "old" },
    { origin: "local" as const },
    { threadId: "board-only", boardToolsEnabled: true },
  ]) {
    await restarted.execute(
      { task: task(), directory, state: "assigned", ...extra },
      mapping,
      false,
    );
  }
  assert.equal(options[3].dynamicTools, undefined);
  assert.equal(options[4].dynamicTools, undefined);
  assert.deepEqual(
    options[5].dynamicTools.map((tool: any) => tool.name),
    ["board_read", "board_post"],
  );
  await restarted.close();
});
