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
