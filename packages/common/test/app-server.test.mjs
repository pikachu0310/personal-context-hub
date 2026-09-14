import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { AppServerCodex } from "@ido/common/runtime/codex/app-server";

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

test("plan/default collaboration modes use the configured model without widening sandbox or approvals", async () => {
  const fake = server({
    handle(message, emit) {
      if (message.method === "thread/start") {
        emit({
          id: message.id,
          result: { thread: { id: "planning" }, model: "fixture-model" },
        });
        return true;
      }
      if (message.method === "turn/start") {
        emit({ id: message.id, result: { turn: { id: "turn" } } });
        emit({
          method: "item/completed",
          params: {
            threadId: "planning",
            turnId: "turn",
            item: { type: "plan", id: "plan", text: "Read, then discuss." },
          },
        });
        emit({
          method: "turn/completed",
          params: {
            threadId: "planning",
            turn: { id: "turn", status: "completed" },
          },
        });
        return true;
      }
    },
  });
  try {
    const thread = fake.client.startThread({
      sandboxMode: "read-only",
      networkAccessEnabled: false,
      approvalPolicy: "on-request",
    });
    for (const mode of ["plan", "default"]) {
      const result = await thread.run("Discuss", { collaborationMode: mode });
      assert.equal(result.finalResponse, "Read, then discuss.");
    }
    const turns = fake.messages.filter(
      (message) => message.method === "turn/start",
    );
    assert.deepEqual(
      turns.map((turn) => turn.params.collaborationMode.mode),
      ["plan", "default"],
    );
    assert.equal(
      turns[1].params.collaborationMode.settings.developer_instructions,
      null,
    );
    for (const turn of turns) {
      assert.equal(
        turn.params.collaborationMode.settings.model,
        "fixture-model",
      );
      assert.deepEqual(turn.params.sandboxPolicy, {
        type: "readOnly",
        networkAccess: false,
      });
      assert.equal(turn.params.approvalPolicy, "on-request");
    }
  } finally {
    await fake.client.close();
  }
});

test("desktop fails before turn start if effective sandbox is read-only", async () => {
  const fake = server({
    handle(message, emit) {
      if (message.method !== "thread/start") return false;
      emit({
        id: message.id,
        result: { thread: { id: "readonly" }, sandbox: { type: "readOnly" } },
      });
      return true;
    },
  });
  try {
    const thread = fake.client.startThread({ requireWritableSandbox: true });
    const { events } = await thread.runStreamed("test");
    await assert.rejects(events.next(), {
      code: "AGENT_SANDBOX_NOT_READY",
    });
    assert.equal(
      fake.messages.some((message) => message.method === "turn/start"),
      false,
    );
  } finally {
    await fake.client.close();
  }
});

test("interactive desktop approvals answer only supported operations and never grant session-wide access", async () => {
  const fake = server();
  fake.client.options.onApprovalRequest = async (_method, params) => ({
    decision: params.command === "git status" ? "accept" : "acceptForSession",
  });
  await fake.client.connect();
  fake.emit({
    id: 801,
    method: "item/commandExecution/requestApproval",
    params: { command: "git status" },
  });
  fake.emit({
    id: 802,
    method: "item/commandExecution/requestApproval",
    params: { command: "other" },
  });
  fake.emit({ id: 803, method: "unknown/requestApproval", params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.messages.find((x) => x.id === 801).result, {
    decision: "accept",
  });
  assert.deepEqual(fake.messages.find((x) => x.id === 802).result, {
    decision: "decline",
  });
  assert.equal(fake.messages.find((x) => x.id === 803).error.code, -32601);
  fake.client.options.onApprovalRequest = async () => ({ decision: "accept" });
  fake.emit({
    id: 804,
    method: "item/permissions/requestApproval",
    params: { permissions: { network: { enabled: true } } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.messages.find((x) => x.id === 804).result, {
    permissions: { network: { enabled: true } },
    scope: "turn",
  });
  fake.client.options.onApprovalRequest = async () => ({ decision: "decline" });
  fake.emit({
    id: 805,
    method: "item/permissions/requestApproval",
    params: { permissions: { network: { enabled: true } } },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fake.messages.find((x) => x.id === 805).result, {
    permissions: {},
    scope: "turn",
  });
  await fake.client.close();
});

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
