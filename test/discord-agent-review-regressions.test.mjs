import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentWorkerGateway } from "../src/discord-agent-worker-gateway.mjs";
import {
  DiscordAgentWorker,
  LocalCodexWorkerExecutor,
} from "../src/discord-agent-worker.mjs";
import { CodexVoiceRunner } from "../src/execution/codex/runner.mjs";
import { TaskQueue } from "../src/engine/task-queue.mjs";
import { bindExecution } from "../src/execution/port.mjs";
import { createCodexBackend } from "../src/execution/codex/backend.mjs";

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close(code) {
    this.closeCode = code;
  }
  finishClose() {
    this.readyState = 3;
    this.emit("close", this.closeCode);
  }
}
class Server extends EventEmitter {
  constructor() {
    super();
    queueMicrotask(() => this.emit("listening"));
  }
  close(callback) {
    callback();
  }
}
async function createGateway(t) {
  const online = new Map();
  const registry = {
    authenticate: () => true,
    markOnline: (id, value) => {
      online.set(id, value);
      return { agentId: id };
    },
    snapshot: () => [],
    describe: (id) => ({ agentId: id }),
  };
  const gateway = new AgentWorkerGateway({
    registry,
    WebSocketServerClass: Server,
  });
  await gateway.start();
  t.after(() => gateway.stop());
  return { gateway, online };
}
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("an idle unauthenticated connection expires without sending any message", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const { gateway } = await createGateway(t);
  const socket = new Socket();
  gateway.server.emit("connection", socket);
  t.mock.timers.tick(29_999);
  assert.equal(socket.closeCode, undefined);
  t.mock.timers.tick(1);
  assert.equal(socket.closeCode, 4008);
  socket.finishClose();
});

test("closing a replaced socket preserves the replacement's online state and task lease", async (t) => {
  const { gateway, online } = await createGateway(t);
  const oldSocket = new Socket();
  const replacement = new Socket();
  for (const socket of [oldSocket, replacement]) {
    gateway.server.emit("connection", socket);
    socket.emit(
      "message",
      JSON.stringify({ type: "authenticate", agentId: "worker" }),
    );
    await flush();
  }
  assert.equal(oldSocket.closeCode, 4001);
  const task = {
    id: "task",
    assignedAgentId: "worker",
    activeSpecRevision: 2,
    modelSelection: {
      model: "gpt-6-astra",
      reasoningEffort: "high",
      explicit: true,
    },
    acceptanceCriteria: ["tests pass"],
    sourceStatements: [
      { sequence: 1, text: "test request", speakerName: "Operator" },
    ],
  };
  const result = gateway.runTask(task);
  let settled = false;
  void result.then(() => {
    settled = true;
  });
  const oldLease = replacement.sent.find((message) => message.type === "task");
  oldSocket.emit(
    "message",
    JSON.stringify({
      type: "result",
      leaseId: oldLease.leaseId,
      result: "forged",
    }),
  );
  await flush();
  assert.equal(settled, false);
  oldSocket.finishClose();
  assert.equal(online.get("worker"), true);
  assert.equal(gateway.connections.get("worker"), replacement);
  const lease = replacement.sent.find((message) => message.type === "task");
  assert.equal(lease.activeSpecRevision, 2);
  assert.deepEqual(lease.modelSelection, task.modelSelection);
  assert.deepEqual(lease.acceptanceCriteria, task.acceptanceCriteria);
  replacement.emit(
    "message",
    JSON.stringify({
      type: "result",
      leaseId: lease.leaseId,
      result: "done",
      evidence: {
        tests: [
          {
            command: "npm test",
            exitCode: 0,
            outcome: "passed",
            scope: "command_exit",
          },
        ],
      },
    }),
  );
  assert.equal(await result, "done");
  assert.equal(task.evidence.tests[0].outcome, "passed");
  assert.equal(task.evidence.tests[0].command, "npm test");
  replacement.finishClose();
});

for (const code of [4001, 4002, 4003]) {
  test(`worker close ${code} stops automatic reconnection`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let opened = 0;
    class WorkerSocket extends Socket {
      constructor() {
        super();
        opened++;
      }
    }
    const worker = new DiscordAgentWorker({
      gatewayUrl: "ws://127.0.0.1:8787",
      credential: { agentId: "worker" },
      WebSocketClass: WorkerSocket,
      executor: {},
    });
    const ready = assert.rejects(
      worker.connect(),
      /closed before authentication/,
    );
    worker.socket.close(code);
    worker.socket.finishClose();
    await ready;
    t.mock.timers.tick(10_000);
    assert.equal(opened, 1);
    await worker.stop();
  });
}

test("streamed worker execution records passing, failing and unknown verification commands", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "agent-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const executor = new LocalCodexWorkerExecutor({
    workingDirectory: directory,
    workspaceDirectory: directory,
    codex: {
      startThread: () => ({
        id: "thread",
        runStreamed: async () => ({
          events: (async function* () {
            for (const exit_code of [0, 1, undefined])
              yield {
                type: "item.completed",
                item: {
                  type: "command_execution",
                  command: "npm test",
                  exit_code,
                },
              };
            yield {
              type: "item.completed",
              item: { type: "agent_message", text: "done" },
            };
          })(),
        }),
      }),
    },
  });
  executor.workspaces = {
    prepare: async () => directory,
    collect: async () => ({}),
  };
  const result = await executor.run({
    id: "evidence",
    title: "test",
    request: "test",
  });
  assert.equal(result.evidence.commands, 3);
  assert.equal(result.evidence.failedCommands, 1);
  assert.equal(result.evidence.unknownCommands, 1);
  assert.equal(result.evidence.tests.length, 3);
  assert.deepEqual(
    result.evidence.tests.map((entry) => entry.outcome),
    ["passed", "failed", "unknown"],
  );
});

test("remote tasks cannot invoke a local peer review", async () => {
  const runner = new CodexVoiceRunner(
    { peerReviewEnabled: true },
    {
      codex: { startThread: () => assert.fail("local review must not start") },
      agentTeam: {
        list: () => [],
        selectReviewer: () =>
          assert.fail("local reviewer must not be selected"),
      },
    },
  );
  assert.equal(await runner.reviewTask({ remoteExecution: true }), undefined);
  assert.equal(
    await runner.reviewTask({ assignedAgentTransport: "remote" }),
    undefined,
  );
  let reviews = 0;
  const queue = new TaskQueue({
    runTask: async (task) => {
      task.remoteExecution = true;
      task.runRevision = 1;
      return "done";
    },
    reviewTask: () => {
      reviews++;
    },
    createTaskThread: async () => ({
      post: async () => {},
      update: async () => {},
    }),
    postText: async () => {},
  });
  await queue.enqueueDurable({
    id: "remote",
    title: "remote task",
    request: "test",
  });
  for (
    let i = 0;
    i < 100 && queue.tasks.get("remote").state !== "completed";
    i++
  )
    await flush();
  assert.equal(queue.tasks.get("remote").state, "completed");
  assert.equal(reviews, 0);
  await queue.stop();
});

test("the execution boundary retains agent assignment and task specification", async () => {
  let received;
  const runner = {
    runTask: async (request) => {
      received = structuredClone({
        ...request,
        checkpoint: undefined,
        flushSteering: undefined,
      });
      request.codexThreadId = "local-thread";
      return "done";
    },
  };
  const execution = bindExecution(createCodexBackend({}, { runner }));
  const task = {
    id: "assigned",
    issueId: "issue",
    assignedAgentId: "builder",
    assignedAgentName: "Builder",
    assignedAgentTransport: "local",
    assignmentReason: "implementation",
    activeSpecRevision: 3,
    additionalInstructionSource: { type: "agent_review", agentId: "reviewer" },
    acceptanceCriteria: ["tests pass"],
    checkpoint: async () => {},
  };
  assert.equal(await execution.runTask(task), "done");
  assert.equal(received.assignedAgentId, "builder");
  assert.equal(received.issueId, "issue");
  assert.equal(received.activeSpecRevision, 3);
  assert.deepEqual(
    received.additionalInstructionSource,
    task.additionalInstructionSource,
  );
  assert.deepEqual(received.acceptanceCriteria, task.acceptanceCriteria);
  assert.equal(task.codexThreadId, "local-thread");
});
