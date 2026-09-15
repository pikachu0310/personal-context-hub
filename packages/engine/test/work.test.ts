import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, Command } from "@ido/common/contracts/protocol";
import type { Device } from "../src/domain/models.js";
import { Store } from "../src/adapters/sqlite/store.js";
import { Tasks } from "../src/processing/tasks/service.js";
import { createWorkPort } from "../src/processing/tasks/work.js";
import { Scheduler } from "../src/clients/scheduler.js";
import { ClientConnections } from "../src/adapters/client-ws/connections.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ido-work-port-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const user = store.createUser("operator", "fixture-password-long", "member");
  store.put("project", "project", {
    id: "project",
    name: "Example",
    remote: "",
  });
  store.put("meeting", "meeting", {
    id: "meeting",
    name: "Example",
    summary: "",
  });
  const tasks = new Tasks(store);
  const work = createWorkPort({ repository: store, tasks });
  const request = {
    requestKey: "meeting:question:1",
    meetingId: "meeting",
    projectId: "project",
    authorId: user.id,
    title: "Read source",
    request: "Find the implementation",
    kind: "research",
    sourceIds: ["message-1"],
    sourceSequences: [1],
    sourceStatements: [
      { id: "message-1", authorId: user.id, text: "Find the implementation" },
    ],
    executionPolicy: { sandboxMode: "read-only" as const },
  };
  const device = (id: string, version?: number): Device => ({
    id,
    name: id,
    userId: user.id,
    publicKey: "fixture",
    revoked: false,
    codexConnected: true,
    generation: 1,
    grants: [{ projectId: "project", network: true, slots: 4 }],
    slots: 4,
    lastAssigned: 0,
    executionPolicyVersion: version,
  });
  return { directory, store, tasks, work, request, user, device };
}

test("WorkPort preserves provenance, returns native identity and reconciles durable duplicate requests", async (t) => {
  const { store, work, request, user } = await fixture(t);
  const task = work.submit(request);
  request.sourceIds.push("caller-mutated");
  request.sourceStatements[0].text = "caller mutation";
  const repeated = work.submit(request);
  assert.equal(repeated.id, task.id);
  assert.equal(work.list("meeting").length, 1);
  assert.deepEqual(work.list()[0].sourceIds, ["message-1"]);
  assert.equal(
    work.list()[0].sourceStatements?.[0].text,
    "Find the implementation",
  );
  assert.equal(work.getReceipt(request)?.id, task.id);
  task.sourceIds!.push("result mutation");
  assert.deepEqual(store.get<Task>("task", task.id)?.sourceIds, ["message-1"]);
  assert.throws(
    () => work.submit({ ...request, meetingId: "different" }),
    /REQUEST_MEETING_MISMATCH/,
  );
  const viewer = store.createUser("viewer", "fixture-password-long", "viewer");
  assert.throws(
    () =>
      work.submit({ ...request, requestKey: "viewer", authorId: viewer.id }),
    /PERMISSION_DENIED/,
  );
  assert.throws(
    () =>
      work.submit({ ...request, requestKey: "unknown", authorId: "missing" }),
    /PERMISSION_DENIED/,
  );
  assert.equal(
    work.getReceipt({ ...request, authorId: user.id })?.id,
    repeated.id,
  );
});

test("scheduler negotiates read-only execution before dispatch without blocking legacy unrestricted work", async (t) => {
  const { store, tasks, work, request, device } = await fixture(t);
  store.put("device", "legacy", device("legacy"));
  const restricted = work.submit(request);
  const unrestricted = tasks.createTask({
    projectId: "project",
    meetingId: "meeting",
    authorId: request.authorId,
    text: "Existing task",
    requestId: "legacy",
    network: false,
  });
  const scheduler = new Scheduler(store);
  scheduler.schedule(new Set(["legacy"]));
  assert.equal(store.get<Task>("task", restricted.id)?.state, "queued");
  assert.equal(store.get<Task>("task", unrestricted.id)?.clientId, "legacy");
  store.put("device", "modern", device("modern", 1));
  scheduler.schedule(new Set(["legacy", "modern"]));
  const dispatched = store.pending("modern")[0].task as Task;
  assert.equal(dispatched.id, restricted.id);
  assert.ok(
    dispatched.participants?.some(
      (person) => person.id === restricted.authorId,
    ),
  );
  assert.deepEqual(dispatched.executionPolicy, { sandboxMode: "read-only" });
  assert.deepEqual(dispatched.sourceIds, ["message-1"]);
});

test("durable controls distinguish input versions, retries and client delivery receipts", async (t) => {
  const { store, tasks, work, request, device } = await fixture(t);
  store.put("device", "client", device("client", 1));
  const task = work.submit(request);
  new Scheduler(store).schedule(new Set(["client"]));
  const control = {
    taskId: task.id,
    authorId: request.authorId,
    type: "instruction" as const,
    instruction: "Use the corrected name",
    requestKey: "correction-1",
    expectedControlVersion: 0,
  };
  const receipt = work.control(control);
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.delivery, "pending");
  assert.equal(receipt.specRevision, 2);
  const dispatched = store
    .pending("client")
    .find((command) => command.type === "steer")!;
  assert.equal(dispatched.sender?.id, request.authorId);
  assert.equal(dispatched.sender?.name, "operator");
  assert.equal(typeof dispatched.sentAt, "number");
  assert.equal(store.get<Task>("task", task.id)?.revision, 1);
  assert.equal(work.control(control).id, receipt.id);
  assert.equal(
    store.pending("client").filter((command) => command.type === "steer")
      .length,
    1,
  );
  assert.throws(
    () => work.control({ ...control, requestKey: "new-stale-key" }),
    /TASK_CONTROL_SUPERSEDED/,
  );
  const result: Command = {
    v: 1,
    type: "result",
    taskId: task.id,
    runId: task.runId,
    revision: 1,
    specRevision: 1,
    state: "running",
    result: "Old result",
    effectiveExecutionPolicy: { sandboxMode: "workspace-write" },
  };
  assert.equal(tasks.updateResult("client", 1, result), true);
  assert.equal(work.getResult(task.id)?.superseded, true);
  assert.equal(
    store.get<Task>("task", task.id)?.effectiveExecutionPolicy?.sandboxMode,
    "read-only",
  );
  assert.equal(
    tasks.updateResult("client", 1, {
      ...result,
      specRevision: 2,
      state: "completed",
      result: "Corrected result",
      controlReceipts: [
        { id: receipt.id, controlVersion: 1, delivery: "applied" },
      ],
    }),
    true,
  );
  assert.equal(work.getResult(task.id)?.superseded, false);
  assert.equal(work.getResult(task.id)?.runRevision, 1);
  assert.equal(work.control(control).delivery, "applied");
  const retry = work.control({
    taskId: task.id,
    authorId: request.authorId,
    type: "retry",
    requestKey: "retry-1",
    expectedControlVersion: 1,
  });
  assert.equal(retry.specRevision, 2);
  assert.equal(store.get<Task>("task", task.id)?.revision, 2);
  assert.equal(tasks.updateResult("client", 1, result), false);
});

test("queued stop is complete locally while running stop waits for the worker receipt", async (t) => {
  const { store, tasks, work, request, device } = await fixture(t);
  const queued = work.submit(request);
  assert.equal(
    work.control({
      taskId: queued.id,
      authorId: request.authorId,
      type: "stop",
      requestKey: "stop-queued",
    }).delivery,
    "stopped",
  );
  store.put("device", "client", device("client", 1));
  const running = work.submit({ ...request, requestKey: "running" });
  new Scheduler(store).schedule(new Set(["client"]));
  const stop = {
    taskId: running.id,
    authorId: request.authorId,
    type: "stop" as const,
    requestKey: "stop-running",
  };
  const receipt = work.control(stop);
  assert.equal(receipt.delivery, "pending");
  tasks.updateResult("client", 1, {
    v: 1,
    type: "result",
    taskId: running.id,
    runId: running.runId,
    revision: 1,
    state: "cancelled",
    specRevision: 1,
    controlReceipts: [
      { id: receipt.id, controlVersion: 1, delivery: "stopped" },
    ],
  });
  assert.equal(work.control(stop).delivery, "stopped");
});

test("unknown instruction delivery remains explicit until a deliberate resolution", async (t) => {
  const { store, tasks, work, request, device } = await fixture(t);
  store.put("device", "client", device("client", 1));
  const task = work.submit(request);
  new Scheduler(store).schedule(new Set(["client"]));
  const change = {
    taskId: task.id,
    authorId: request.authorId,
    type: "instruction" as const,
    instruction: "Correction",
    requestKey: "correction",
  };
  const receipt = work.control(change);
  tasks.updateResult("client", 1, {
    v: 1,
    type: "result",
    taskId: task.id,
    runId: task.runId,
    revision: 1,
    state: "interrupted",
    specRevision: 2,
    result: "Unconfirmed",
    controlReceipts: [
      { id: receipt.id, controlVersion: 1, delivery: "uncertain" },
    ],
  });
  assert.equal(work.getResult(task.id)?.superseded, true);
  work.control({
    taskId: task.id,
    authorId: request.authorId,
    type: "retry",
    requestKey: "resolve",
    instructionResolution: "discard",
  });
  assert.equal(work.control(change).delivery, "rejected");
  assert.equal(
    store.pending("client").at(-1)?.instructionResolution,
    "discard",
  );
});

test("a downgraded Client cannot replay restrictive outbox work or receive a restrictive retry", async (t) => {
  const { store, tasks, work, request, device } = await fixture(t);
  store.put("device", "client", device("client", 1));
  const task = work.submit(request);
  new Scheduler(store).schedule(new Set(["client"]));
  const connections = new ClientConnections(store, () => {});
  const sent: Command[] = [];
  connections.peers.set("client", {
    readyState: 1,
    send: (value: string) => sent.push(JSON.parse(value)),
  } as any);
  store.put("project-member", "project:client", {
    projectId: "project",
    deviceId: "client",
  });
  connections.ready.add("client");
  store.put("device", "client", device("client"));
  connections.flush();
  assert.equal(sent.length, 0);
  assert.equal(store.pending("client").length, 1);
  store.put("device", "client", device("client", 1));
  connections.flush();
  assert.equal(sent[0].type, "execute");
  tasks.updateResult("client", 1, {
    v: 1,
    type: "result",
    taskId: task.id,
    runId: task.runId,
    revision: 1,
    specRevision: 1,
    state: "completed",
    result: "done",
  });
  store.put("device", "client", device("client"));
  assert.throws(
    () =>
      work.control({
        taskId: task.id,
        authorId: request.authorId,
        type: "retry",
        requestKey: "retry",
      }),
    /WORKER_POLICY_UNSUPPORTED/,
  );
  assert.equal(store.get<Task>("task", task.id)?.revision, 1);
  assert.equal(store.get<Task>("task", task.id)?.controlVersion, 0);
});

test("a worker failure before producing text is returned as a failure event", async (t) => {
  const { store, tasks, work, request, device } = await fixture(t);
  store.put("device", "client", device("client", 1));
  const task = work.submit(request);
  new Scheduler(store).schedule(new Set(["client"]));
  tasks.updateResult("client", 1, {
    v: 1,
    type: "result",
    taskId: task.id,
    runId: task.runId,
    revision: 1,
    specRevision: 1,
    state: "failed",
    progress: "Execution failed.",
  });
  const result = work.getResult(task.id);
  assert.equal(result?.state, "failed");
  assert.equal(result?.superseded, false);
  assert.match(result!.result, /失敗/);
});

test("Codex-unlinked approved Clients receive no task even with execution grants", async (t) => {
  const { store, work, request, device } = await fixture(t);
  const client = device("client", 1);
  client.codexConnected = false;
  store.put("device", client.id, client);
  const task = work.submit(request),
    scheduler = new Scheduler(store);
  scheduler.schedule(new Set([client.id]));
  assert.equal(store.get<Task>("task", task.id)?.state, "queued");
  assert.equal(store.pending(client.id).length, 0);
  client.codexConnected = true;
  store.put("device", client.id, client);
  scheduler.schedule(new Set([client.id]));
  assert.equal(store.get<Task>("task", task.id)?.clientId, client.id);
});

test("queued instructions retain separate authors and timestamps without changing execution text", async (t) => {
  const { store, tasks, work, request, user } = await fixture(t);
  const task = work.submit(request);
  tasks.control(task.id, user.id, "steer", "queued follow-up", {
    requestKey: "queued-message",
  });
  const saved = store.get<Task>("task", task.id)!;
  assert.equal(saved.initialText, request.request);
  assert.match(saved.text, /queued follow-up/);
  assert.equal(saved.queuedInstructions?.[0].sender?.id, user.id);
  assert.equal(saved.queuedInstructions?.[0].text, "queued follow-up");
  assert.equal(typeof saved.queuedInstructions?.[0].sentAt, "number");
  tasks.control(task.id, user.id, "steer", "queued follow-up", {
    requestKey: "queued-message",
  });
  assert.deepEqual(
    store.get<Task>("task", task.id)?.queuedInstructions,
    saved.queuedInstructions,
  );
});

test("priority updates reorder queued work, suppress resolved work, preserve running work and reject stale versions", async (t) => {
  const { store, work, request, device } = await fixture(t);
  const { taskPriority } = await import("../src/processing/tasks/priority.js");
  const { evaluation } = await import("./priority-fixture.js");
  const make = (key: string, score: number) =>
    work.submit({
      ...request,
      requestKey: key,
      title: key,
      trigger: "proactive",
      priority: taskPriority(
        evaluation([], {
          immediacy: score,
          importance: score,
          certainty: score,
          intent: "proposal",
        }),
        "research",
        { batchId: key, version: 1, runRevision: 1 },
      ),
    });
  const low = make("low", 2),
    high = make("high", 4),
    other = make("other", 3);
  const worker = device("worker", 1);
  worker.slots = 1;
  worker.grants[0].slots = 1;
  store.put("device", "worker", worker);
  const scheduler = new Scheduler(store);
  scheduler.schedule(new Set(["worker"]));
  assert.equal(store.get<Task>("task", high.id)?.state, "assigned");
  assert.equal(store.get<Task>("task", low.id)?.state, "queued");
  const update = (
    task: Task,
    resolution: "resolved" | "unresolved",
    version = task.priority!.version,
  ) => ({
    taskId: task.id,
    projectId: task.projectId,
    expectedRevision: task.revision,
    expectedControlVersion: task.controlVersion ?? 0,
    expectedVersion: version,
    priority: taskPriority(evaluation([], { resolution }), task.kind, {
      batchId: `update-${task.id}`,
      version: version + 1,
      runRevision: task.revision,
    }),
  });
  assert.deepEqual(
    work.prioritize!([
      update(high, "resolved"),
      update(other, "resolved"),
      update(low, "unresolved"),
    ]),
    [high.id, other.id, low.id],
  );
  assert.equal(store.get<Task>("task", high.id)?.state, "assigned");
  assert.deepEqual(work.prioritize!([update(low, "resolved")]), []);
  const current = store.get<Task>("task", low.id)!;
  assert.deepEqual(
    work.prioritize!([
      { ...update(current, "resolved"), expectedRevision: 99 },
      { ...update(current, "resolved"), expectedControlVersion: 99 },
    ]),
    [],
  );
  store.put("task", high.id, {
    ...store.get<Task>("task", high.id)!,
    state: "completed",
  });
  scheduler.schedule(new Set(["worker"]));
  assert.equal(store.get<Task>("task", low.id)?.state, "assigned");
  assert.equal(store.get<Task>("task", other.id)?.state, "queued");
  const resumed = createWorkPort({
    repository: store,
    tasks: new Tasks(store),
  });
  assert.equal(
    resumed.list().find((task) => task.id === other.id)?.priority?.evaluation
      .resolution,
    "resolved",
  );
});

test("equal priority is dispatched FIFO", async (t) => {
  const { store, work, request, device } = await fixture(t);
  const first = work.submit({ ...request, requestKey: "first" });
  const second = work.submit({ ...request, requestKey: "second" });
  store.put("task", first.id, { ...first, createdAt: 100 });
  store.put("task", second.id, { ...second, createdAt: 200 });
  const worker = device("worker", 1);
  worker.slots = 1;
  worker.grants[0].slots = 1;
  store.put("device", "worker", worker);
  new Scheduler(store).schedule(new Set(["worker"]));
  assert.equal(store.get<Task>("task", first.id)?.state, "assigned");
  assert.equal(store.get<Task>("task", second.id)?.state, "queued");
});

test("one response registers all priorities before dispatch and releases exactly once", async (t) => {
  const { store, tasks, request, device } = await fixture(t);
  const { taskPriority } = await import("../src/processing/tasks/priority.js");
  const { evaluation } = await import("./priority-fixture.js");
  const worker = device("worker", 1);
  worker.slots = 1;
  worker.grants[0].slots = 1;
  store.put("device", "worker", worker);
  let changes = 0;
  const work = createWorkPort({
    repository: store,
    tasks,
    onChange: () => {
      changes++;
      new Scheduler(store).schedule(new Set(["worker"]));
    },
  });
  const release = work.deferDispatch!();
  const low = work.submit({
    ...request,
    requestKey: "low",
    priority: taskPriority(
      evaluation([], {
        intent: "proposal",
        immediacy: 1,
        certainty: 2,
        importance: 2,
      }),
      "research",
      { batchId: "batch", version: 1, runRevision: 1 },
    ),
  });
  const high = work.submit({
    ...request,
    requestKey: "high",
    priority: taskPriority(evaluation(), "research", {
      batchId: "batch",
      version: 1,
      runRevision: 1,
    }),
  });
  assert.equal(changes, 0);
  release();
  release();
  assert.equal(changes, 1);
  assert.equal(store.get<Task>("task", low.id)?.state, "queued");
  assert.equal(store.get<Task>("task", high.id)?.state, "assigned");
});

test("scheduler caps older eight-slot grants at four and dispatches the fifth only after a slot is free", async (t) => {
  const { store, work, request, device } = await fixture(t);
  const worker = device("worker", 1);
  worker.slots = 8;
  worker.grants[0].slots = 8;
  store.put("device", worker.id, worker);
  for (let index = 0; index < 5; index++)
    work.submit({
      ...request,
      requestKey: `capacity-${index}`,
      title: `Research ${index}`,
    });
  const scheduler = new Scheduler(store);
  const schedule = () => scheduler.schedule(new Set([worker.id]));
  schedule();
  assert.equal(
    store.list<Task>("task").filter((task) => task.state === "assigned").length,
    4,
  );
  const waiting = store
    .list<Task>("task")
    .find((task) => task.state === "queued")!;
  schedule();
  assert.equal(store.get<Task>("task", waiting.id)?.state, "queued");
  const finished = store
    .list<Task>("task")
    .find((task) => task.state === "assigned")!;
  store.put("task", finished.id, { ...finished, state: "completed" });
  schedule();
  assert.equal(store.get<Task>("task", waiting.id)?.state, "assigned");
  assert.equal(
    store.list<Task>("task").filter((task) => task.state === "assigned").length,
    4,
  );
});
