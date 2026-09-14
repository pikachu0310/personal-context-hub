import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkPort } from "../src/engine/work-port.mjs";
import { authorizeMeetingResearchTasks } from "../src/engine/observation/observation.mjs";
import { TaskQueue } from "../src/engine/task-queue.mjs";
import { bindExecution } from "../src/execution/port.mjs";
import { createCodexBackend } from "../src/execution/codex/backend.mjs";
import { selectTaskProfile } from "../src/execution/codex/workspace.mjs";
import { normalizeExecutionPolicy } from "../src/engine/work-policy.mjs";
import { AgentWorkerGateway } from "../src/discord-agent-worker-gateway.mjs";
import {
  DiscordAgentWorker,
  LocalCodexWorkerExecutor,
} from "../src/discord-agent-worker.mjs";

const surface = { post: async () => {}, update: async () => {} };
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("read-only research requires trusted question eligibility and retains its actual source author", () => {
  const source = {
    sequence: 1,
    meetingId: "meeting",
    userId: "owner",
    sourceUserId: "permitted-operator",
    speakerName: "Operator",
    text: "この処理はどこに実装されていますか？",
    taskEligible: false,
    readOnlyResearchEligible: true,
  };
  const proposal = {
    title: "調査",
    kind: "research",
    sourceSequences: [1],
    request: "Forged model request",
    modelSelection: { model: "gpt-6-astra", explicit: true },
    executionPolicy: { sandboxMode: "workspace-write" },
  };
  const [task] = authorizeMeetingResearchTasks(
    [proposal, { ...proposal, title: "Duplicate" }],
    [source],
    "owner",
  );
  assert.equal(task.request, source.text);
  assert.equal(task.sourceStatements[0].userId, "permitted-operator");
  assert.equal(task.sourceStatements[0].meetingId, "meeting");
  assert.deepEqual(task.executionPolicy, { sandboxMode: "read-only" });
  assert.equal(task.modelSelection, undefined);
  assert.equal(source.taskEligible, false);
  for (const change of [
    { readOnlyResearchEligible: undefined },
    { readOnlyResearchEligible: false, taskEligible: true },
    { contextOnly: true },
    { handledAction: { type: "stop" } },
    { userId: "unauthorized-guest" },
  ])
    assert.deepEqual(
      authorizeMeetingResearchTasks(
        [proposal],
        [{ ...source, ...change }],
        "owner",
      ),
      [],
    );
  for (const change of [
    { kind: "implementation" },
    { sourceSequences: [] },
    { sourceSequences: [1, 2] },
    { sourceSequences: ["1"] },
    { sourceSequences: undefined },
  ])
    assert.deepEqual(
      authorizeMeetingResearchTasks(
        [{ ...proposal, ...change }],
        [source],
        "owner",
      ),
      [],
    );
});

test("work submission retains explicit restrictions across durable restore and clones its data", async (t) => {
  const queue = new TaskQueue({
    concurrency: 0,
    runTask: () => assert.fail("queued work must not run"),
    createTaskThread: async () => surface,
    postText: async () => {},
  });
  t.after(() => queue.stop());
  const work = createWorkPort(queue);
  const request = {
    id: "research",
    requestKey: "meeting:statement:1",
    title: "Inspect source",
    request: "Find the cause",
    sourceSequences: [1],
    executionPolicy: { sandboxMode: "workspace-write" },
  };
  assert.equal(await work.submitResearch(request), true);
  request.sourceSequences.push(2);
  assert.equal(await work.submitResearch(request), true);
  assert.equal(work.list().length, 1);
  assert.equal(work.getReceipt(request.requestKey).id, "research");
  const snapshot = queue.snapshot();
  assert.deepEqual(snapshot[0].sourceSequences, [1]);
  assert.deepEqual(snapshot[0].executionPolicy, { sandboxMode: "read-only" });
  work.list()[0].title = "mutated";
  assert.equal(work.list()[0].title, "Inspect source");
  const restored = new TaskQueue({
    createTaskThread: async () => surface,
    postText: async () => {},
  });
  t.after(() => restored.stop());
  await restored.restore(snapshot, async () => surface);
  assert.deepEqual(restored.snapshot()[0].executionPolicy, {
    sandboxMode: "read-only",
  });
  assert.equal(createWorkPort(restored).getResult("research").id, "research");
});

test("the work port preserves control receipts without claiming termination", async () => {
  let received;
  const receipt = {
    type: "cancelled",
    persisted: true,
    waitingForWorker: true,
  };
  const work = createWorkPort({
    handleVoiceControlDurable: async (control) => {
      received = control;
      return receipt;
    },
  });
  const control = {
    type: "stop",
    taskId: "task",
    requestKey: "stop-1",
    expectedControlVersion: 3,
  };
  const result = await work.control(control);
  assert.deepEqual(received, control);
  assert.notEqual(received, control);
  assert.deepEqual(result, receipt);
  result.persisted = false;
  assert.equal(receipt.persisted, true);
  assert.equal(await createWorkPort().submit({}), false);
  assert.equal(await createWorkPort().control(control), false);
});

test("execution policies restrict authority independently of task classification", () => {
  const legacy = selectTaskProfile({ kind: "research" }, {});
  assert.equal(legacy.sandboxMode, "workspace-write");
  const restricted = selectTaskProfile(
    {
      kind: "implementation",
      executionPolicy: {
        sandboxMode: "workspace-write",
        networkAccessEnabled: true,
      },
      effectiveExecutionPolicy: {
        sandboxMode: "read-only",
        networkAccessEnabled: false,
      },
    },
    {},
  );
  assert.equal(restricted.sandboxMode, "read-only");
  assert.equal(restricted.networkAccessEnabled, false);
  assert.equal(restricted.webSearchMode, "disabled");
  assert.throws(
    () => normalizeExecutionPolicy({ sandboxMode: "danger-full-access" }),
    /Unsupported/,
  );
  assert.throws(
    () => normalizeExecutionPolicy({ additionalDirectories: ["private"] }),
    /Unsupported/,
  );
});

test("review and execution cross the same data-only boundary with policy checkpoints", async () => {
  let reviewed;
  const task = {
    id: "task",
    title: "Research",
    request: "Read source",
    result: "Found evidence",
    assignedAgentId: "reader",
    workingDirectory: "workspace",
    evidence: { commands: 1 },
    executionPolicy: { sandboxMode: "read-only" },
    surface: { post: () => {} },
    checkpoint: async () => {},
  };
  const port = bindExecution(
    createCodexBackend(
      {},
      {
        runner: {
          async runTask(request) {
            assert.deepEqual(request.executionPolicy, task.executionPolicy);
            request.effectiveExecutionPolicy = {
              sandboxMode: "read-only",
              networkAccessEnabled: false,
            };
            await request.checkpoint();
            return "Found evidence";
          },
          async reviewTask(request) {
            reviewed = request;
            return { feedback: "指摘なし", actionable: false };
          },
        },
      },
    ),
  );
  assert.equal(await port.runTask(task), "Found evidence");
  assert.equal(task.effectiveExecutionPolicy.sandboxMode, "read-only");
  assert.deepEqual(await port.reviewTask(task), {
    feedback: "指摘なし",
    actionable: false,
  });
  assert.equal(reviewed.result, task.result);
  assert.equal(reviewed.assignedAgentId, "reader");
  assert.deepEqual(reviewed.evidence, { commands: 1 });
  assert.equal(reviewed.surface, undefined);
  assert.equal(reviewed.checkpoint, undefined);
  reviewed.evidence.commands = 99;
  assert.equal(task.evidence.commands, 1);
  assert.equal(bindExecution({}).reviewTask, undefined);
  assert.equal(bindExecution({}).steerTask, undefined);
});

class Socket extends EventEmitter {
  readyState = 1;
  sent = [];
  send(data) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = 3;
    this.emit("close", 1000);
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

test("restrictive remote work is rejected before sending to legacy workers and propagated to supported workers", async (t) => {
  const gateway = new AgentWorkerGateway({
    registry: {
      authenticate: () => true,
      markOnline: (id) => ({ agentId: id }),
      snapshot: () => [],
      describe: (id) => ({ agentId: id }),
    },
    WebSocketServerClass: Server,
  });
  await gateway.start();
  t.after(() => gateway.stop());
  for (const version of [undefined, 1]) {
    const socket = new Socket();
    gateway.server.emit("connection", socket);
    socket.emit(
      "message",
      JSON.stringify({
        type: "authenticate",
        agentId: "worker",
        executionPolicyVersion: version,
      }),
    );
    await flush();
    const task = {
      id: "research",
      assignedAgentId: "worker",
      executionPolicy: { sandboxMode: "read-only" },
    };
    const result = gateway.runTask(task);
    if (!version) {
      await assert.rejects(result, { code: "WORKER_POLICY_UNSUPPORTED" });
      assert.equal(
        socket.sent.some((message) => message.type === "task"),
        false,
      );
      assert.equal(gateway.pending.size, 0);
      continue;
    }
    const lease = socket.sent.find((message) => message.type === "task");
    assert.deepEqual(lease.executionPolicy, { sandboxMode: "read-only" });
    socket.emit(
      "message",
      JSON.stringify({
        type: "result",
        leaseId: lease.leaseId,
        result: "done",
        effectiveExecutionPolicy: {
          sandboxMode: "workspace-write",
          networkAccessEnabled: false,
        },
      }),
    );
    assert.equal(await result, "done");
    assert.deepEqual(task.effectiveExecutionPolicy, {
      sandboxMode: "read-only",
      networkAccessEnabled: false,
    });
  }
});

test("worker wire whitelist carries restrictive policy but rejects arbitrary local settings", async (t) => {
  let received;
  const worker = new DiscordAgentWorker({
    gatewayUrl: "ws://127.0.0.1:8787",
    credential: { agentId: "worker" },
    WebSocketClass: Socket,
    executor: {
      run: async (task) => {
        received = task;
        return { result: "done" };
      },
    },
  });
  const ready = worker.connect();
  t.after(() => worker.stop());
  worker.socket.emit(
    "message",
    JSON.stringify({ type: "authenticated", agentId: "worker" }),
  );
  await ready;
  worker.socket.emit(
    "message",
    JSON.stringify({
      type: "task",
      leaseId: "lease",
      taskId: "research",
      executionPolicy: {
        sandboxMode: "read-only",
        networkAccessEnabled: false,
      },
      workingDirectory: "untrusted-path",
      codexThreadId: "untrusted-thread",
    }),
  );
  await flush();
  assert.deepEqual(received.executionPolicy, {
    sandboxMode: "read-only",
    networkAccessEnabled: false,
  });
  assert.equal(received.workingDirectory, undefined);
  assert.equal(received.codexThreadId, undefined);
});

test("worker restrictions survive restart and cannot widen on resumed instructions", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "work-policy-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const starts = [];
  const client = {
    startThread: (options) => {
      starts.push(options);
      return {
        id: "research-thread",
        run: async () => ({ finalResponse: "done" }),
      };
    },
    resumeThread: (id, options) => {
      assert.equal(id, "research-thread");
      starts.push(options);
      return { id, run: async () => ({ finalResponse: "continued" }) };
    },
  };
  const execute = async (task) => {
    const executor = new LocalCodexWorkerExecutor({
      workingDirectory: directory,
      workspaceDirectory: directory,
      networkAccess: true,
      codex: client,
    });
    executor.workspaces = {
      prepare: async () => directory,
      collect: async () => ({}),
    };
    return executor.run(task);
  };
  await execute({
    id: "research",
    executionPolicy: { sandboxMode: "read-only", networkAccessEnabled: false },
  });
  const result = await execute({
    id: "research",
    additionalInstruction: "continue",
    executionPolicy: {
      sandboxMode: "workspace-write",
      networkAccessEnabled: true,
    },
  });
  assert.equal(starts.length, 2);
  for (const options of starts) {
    assert.equal(options.sandboxMode, "read-only");
    assert.equal(options.requireWritableSandbox, false);
    assert.equal(options.networkAccessEnabled, false);
    assert.equal(options.webSearchMode, "disabled");
  }
  assert.deepEqual(result.effectiveExecutionPolicy, {
    sandboxMode: "read-only",
    networkAccessEnabled: false,
  });
  const saved = JSON.parse(
    await readFile(join(directory, "research-agent-state.json"), "utf8"),
  );
  assert.equal(saved.effectiveExecutionPolicy.sandboxMode, "read-only");
});
