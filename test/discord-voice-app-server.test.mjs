import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AppServerCodex } from "../src/execution/codex/app-server.mjs";

function server({ handle, requestTimeoutMs = 1000 } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    child.signalCode = "SIGTERM";
    child.emit("exit", null, "SIGTERM");
  };
  const messages = [];
  const emit = (message) => child.stdout.write(JSON.stringify(message) + "\n");
  let buffered = "";
  child.stdin.on("data", (data) => {
    buffered += data.toString();
    while (buffered.includes("\n")) {
      const index = buffered.indexOf("\n");
      const message = JSON.parse(buffered.slice(0, index));
      buffered = buffered.slice(index + 1);
      messages.push(message);
      if (handle?.(message, emit) === true || message.id === undefined)
        continue;
      if (message.method === "initialize") emit({ id: message.id, result: {} });
      if (
        message.method === "thread/start" ||
        message.method === "thread/resume"
      )
        emit({
          id: message.id,
          result: { thread: { id: message.params.threadId ?? "thread1" } },
        });
    }
  });
  return {
    client: new AppServerCodex(
      {},
      { spawnProcess: () => child, requestTimeoutMs },
    ),
    child,
    emit,
    messages,
  };
}

test("App Server normalizes evidence, usage, schema, active steering and thread resume", async () => {
  const fake = server({
    handle(message, emit) {
      if (message.method === "turn/start") {
        emit({
          method: "turn/started",
          params: { threadId: "thread1", turn: { id: "turn1" } },
        });
        emit({ id: message.id, result: { turn: { id: "turn1" } } });
        return true;
      }
      if (message.method === "turn/steer") {
        assert.equal(message.params.expectedTurnId, "turn1");
        emit({ id: message.id, result: { turnId: "turn1" } });
        emit({
          method: "item/completed",
          params: {
            threadId: "other",
            turnId: "else",
            item: { type: "agentMessage", text: "wrong" },
          },
        });
        for (const item of [
          {
            type: "commandExecution",
            command: "npm test",
            exitCode: 0,
            status: "completed",
          },
          {
            type: "fileChange",
            changes: [{ path: "src/a.mjs", kind: { type: "update" } }],
          },
          { type: "agentMessage", text: "updated" },
        ])
          emit({
            method: "item/completed",
            params: { threadId: "thread1", turnId: "turn1", item },
          });
        emit({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread1",
            tokenUsage: {
              last: { inputTokens: 10, outputTokens: 3 },
              total: { inputTokens: 110, outputTokens: 13 },
            },
          },
        });
        emit({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread1",
            tokenUsage: {
              last: { inputTokens: 20, outputTokens: 4 },
              total: { inputTokens: 130, outputTokens: 17 },
            },
          },
        });
        emit({
          method: "turn/completed",
          params: {
            threadId: "thread1",
            turn: { id: "turn1", status: "completed" },
          },
        });
        return true;
      }
    },
  });
  const thread = fake.client.resumeThread("thread1", {
    model: "gpt-5.6-sol",
    sandboxMode: "workspace-write",
    workingDirectory: "/workspace",
    modelReasoningEffort: "low",
  });
  const events = [];
  for await (const event of (
    await thread.runStreamed("initial", { outputSchema: { type: "object" } })
  ).events) {
    events.push(event);
    if (event.type === "thread.started")
      assert.equal(await thread.steer("correction"), true);
  }
  assert.equal(
    events.find((event) => event.item?.type === "command_execution").item
      .exit_code,
    0,
  );
  assert.equal(
    events.find((event) => event.item?.type === "file_change").item.changes[0]
      .kind,
    "update",
  );
  assert.equal(
    events.find((event) => event.item?.type === "agent_message").item.text,
    "updated",
  );
  assert.equal(events.at(-1).usage.output_tokens, 7);
  assert.equal(events.at(-1).usage.input_tokens, 30);
  assert.equal(events.at(-1).usage.scope, "turn");
  assert.equal(
    fake.messages.find((message) => message.method === "thread/resume").params
      .excludeTurns,
    true,
  );
  assert.equal(
    fake.messages.find((message) => message.method === "turn/start").params
      .sandboxPolicy.type,
    "workspaceWrite",
  );
  assert.equal(await thread.steer("too late"), false);
  assert.equal(fake.client.listenerCount("notification"), 0);
  await fake.client.close();
});

test("an unacknowledged turn start kills the worker transport instead of leaving an orphan", async () => {
  const fake = server({
    requestTimeoutMs: 5,
    handle: (message) => message.method === "turn/start",
  });
  await assert.rejects(fake.client.startThread().run("start"), /timed out/);
  assert.equal(fake.child.signalCode, "SIGTERM");
  assert.equal(fake.client.listenerCount("notification"), 0);
});

test("aborting an active turn sends interrupt and settles on the actual terminal event", async () => {
  const controller = new AbortController();
  const fake = server({
    handle(message, emit) {
      if (message.method === "turn/start") {
        emit({ id: message.id, result: { turn: { id: "turn1" } } });
        return true;
      }
      if (message.method === "turn/interrupt") {
        emit({ id: message.id, result: {} });
        emit({
          method: "turn/completed",
          params: {
            threadId: "thread1",
            turn: { id: "turn1", status: "interrupted" },
          },
        });
        return true;
      }
    },
  });
  await assert.rejects(async () => {
    for await (const event of (
      await fake.client
        .startThread()
        .runStreamed("work", { signal: controller.signal })
    ).events)
      if (event.type === "thread.started")
        controller.abort(new Error("cancelled"));
  }, /cancelled/);
  assert.equal(
    fake.messages.filter((message) => message.method === "turn/interrupt")
      .length,
    1,
  );
  await fake.client.close();
});
