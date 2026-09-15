import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Task } from "@ido/common/contracts/protocol";
import { Store } from "../src/adapters/sqlite/store.js";
import { taskSnapshot } from "../src/adapters/client-ws/task-list.js";
import { Scheduler } from "../src/clients/scheduler.js";
import { WorkspaceLifecycle } from "../src/processing/projects/lifecycle.js";
import { Projects } from "../src/processing/projects/service.js";
import { ProjectTeam } from "../src/processing/projects/team.js";
import {
  seedParticipants,
  taskParticipants,
} from "../src/processing/projects/task-participants.js";
import { Tasks } from "../src/processing/tasks/service.js";
import { createWorkPort } from "../src/processing/tasks/work.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ido-task-participants-"));
  let store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const projects = new Projects(store);
  projects.ensure();
  const project = projects.create("Fixture project", "project-request");
  const user = store.createUser("Fixture member", "fixture-password", "member");
  const team = new ProjectTeam(store);
  for (const id of ["worker", "collaborator"]) {
    store.put("device", id, {
      id,
      userId: user.id,
      name: id,
      revoked: false,
      generation: 1,
      publicKey: generateKeyPairSync("ed25519")
        .publicKey.export({ format: "pem", type: "spki" })
        .toString(),
      slots: 1,
      lastAssigned: 0,
      grants: [{ projectId: project.id, network: false, slots: 1 }],
    });
    team.profile(id, { name: id, codexConnected: true });
    team.join(id, project.id);
  }
  for (const id of ["discord-100", "discord-200"])
    store.put("participant", id, { id, name: id, role: "member" });
  const tasks = new Tasks(store);
  const work = createWorkPort({ repository: store, tasks });
  const request = {
    sourcePluginId: "discord",
    requestKey: "discord-request",
    projectId: project.id,
    meetingId: projects.current(project.id).meetingId,
    authorId: "discord-100",
    request: "Implement the agreed feature",
    sourceIds: ["source-a", "source-b"],
    sourceStatements: [
      { id: "source-a", authorId: "discord-100", text: "First source" },
      { id: "source-b", userId: "discord-200", text: "Second source" },
      { id: "source-c", authorId: "client-collaborator", text: "Context only" },
    ],
  };
  const schedule = () => new Scheduler(store).schedule(new Set(["worker"]));
  const read = (id: string) => store.get<Task>("task", id)!;
  const ids = (task: Task) => taskParticipants(store, task).map((p) => p.id);
  return {
    get store() {
      return store;
    },
    tasks,
    work,
    request,
    schedule,
    read,
    ids,
    team,
    project,
    restart() {
      store.close();
      store = new Store(directory);
    },
  };
}

test("new Discord work includes only the assigned executor and bot across snapshots and restart", async (t) => {
  const f = await fixture(t);
  const task = f.work.submit(f.request);
  assert.equal(task.participantPolicy, "execution");
  assert.deepEqual(task.memberStates, {});
  assert.deepEqual(f.ids(task), ["idobot"]);
  assert.equal(task.authorId, f.request.authorId);
  assert.deepEqual(task.sourceStatements, f.request.sourceStatements);
  f.schedule();
  const assigned = f.read(task.id);
  assert.deepEqual(f.ids(assigned), ["worker", "idobot"]);
  const command = f.store
    .pending("worker")
    .find((item) => item.type === "execute")!;
  assert.deepEqual(
    (command.task as Task).participants,
    JSON.parse(JSON.stringify(taskParticipants(f.store, assigned, true))),
  );
  assert.deepEqual(
    f.team.snapshot("worker", f.project.id).tasks[0].participants,
    taskParticipants(f.store, assigned),
  );
  assert.deepEqual(
    taskSnapshot(f.store, new Map(), new Set([f.project.id])).tasks[0]
      .participants,
    taskParticipants(f.store, assigned),
  );
  assert.ok(taskParticipants(f.store, assigned)[0].identityId);
  f.restart();
  assert.equal(f.read(task.id).participantPolicy, "execution");
  assert.deepEqual(f.ids(f.read(task.id)), ["worker", "idobot"]);
});

test("Discord queued and running controls use the bot sender while retaining actor, audit and idempotency", async (t) => {
  const f = await fixture(t);
  const task = f.work.submit(f.request);
  const control = {
    sourcePluginId: "discord",
    taskId: task.id,
    authorId: "discord-200",
    type: "instruction" as const,
    instruction: "Make it blue",
    requestKey: "same-key",
  };
  const queued = f.work.control(control);
  assert.equal(queued.authorId, "discord-200");
  assert.equal(queued.delivery, "queued");
  assert.deepEqual(f.read(task.id).queuedInstructions?.[0].sender, {
    id: "idobot",
    name: "idobot",
    bot: true,
  });
  assert.deepEqual(f.ids(f.read(task.id)), ["idobot"]);
  assert.deepEqual(f.work.control(control), queued);
  const other = f.work.control({ ...control, authorId: "discord-100" });
  assert.notEqual(other.id, queued.id);
  assert.equal(f.read(task.id).queuedInstructions?.length, 2);
  f.schedule();
  for (const type of ["instruction", "stop", "retry"] as const) {
    if (type === "retry")
      f.store.put("task", task.id, { ...f.read(task.id), state: "completed" });
    const receipt = f.work.control({
      ...control,
      type,
      requestKey: type,
      ...(type === "retry" ? { continuation: "Continue the work" } : {}),
    });
    const command = f.store
      .pending("worker")
      .find((item) => item.receiptId === receipt.id)!;
    assert.deepEqual(command.sender, {
      id: "idobot",
      name: "idobot",
      bot: true,
    });
    assert.deepEqual(
      (command.task as Task).participants?.map((p) => p.id),
      ["worker", "idobot"],
    );
    assert.equal(receipt.authorId, "discord-200");
    assert.deepEqual(f.ids(f.read(task.id)), ["worker", "idobot"]);
  }
  const audits = f.store.db
    .prepare("SELECT actor FROM audit WHERE action='task.steer' AND target=?")
    .all(task.id);
  assert.deepEqual(
    audits.map((item) => item.actor),
    ["discord-200", "discord-100", "discord-200"],
  );
  assert.deepEqual(
    f.read(task.id).sourceStatements,
    f.request.sourceStatements,
  );
  f.store.put("participant", "discord-viewer", {
    id: "discord-viewer",
    name: "Viewer",
    role: "viewer",
  });
  assert.throws(
    () => f.work.control({ ...control, authorId: "discord-viewer" }),
    /PERMISSION_DENIED/,
  );
});

test("explicit Client participation and instruction senders survive without undoing exits", async (t) => {
  const f = await fixture(t);
  const task = f.work.submit(f.request);
  f.schedule();
  const lifecycle = new WorkspaceLifecycle(f.store);
  const actor = { deviceId: "collaborator", valid: () => true };
  let current = lifecycle.membership(
    actor,
    task.id,
    true,
    f.read(task.id).membershipVersion,
  );
  assert.deepEqual(f.ids(current), ["worker", "collaborator", "idobot"]);
  current = lifecycle.membership(
    actor,
    task.id,
    false,
    current.membershipVersion,
  );
  const receipt = f.tasks.control(
    task.id,
    "client-collaborator",
    "steer",
    "Direct Client instruction",
  );
  assert.equal(f.read(task.id).memberStates?.collaborator, false);
  assert.deepEqual(f.ids(f.read(task.id)), ["worker", "idobot"]);
  assert.equal(
    f.store.pending("worker").find((item) => item.receiptId === receipt.id)
      ?.sender,
    undefined,
  );
  lifecycle.membership(actor, task.id, true, current.membershipVersion);
  const joined = f.tasks.control(
    task.id,
    "client-collaborator",
    "steer",
    "Another Client instruction",
  );
  assert.equal(
    f.store.pending("worker").find((item) => item.receiptId === joined.id)
      ?.sender?.id,
    "collaborator",
  );
  const task2 = f.work.submit({ ...f.request, requestKey: "second-task" });
  f.tasks.control(
    task2.id,
    "client-collaborator",
    "steer",
    "Join by instruction",
  );
  assert.deepEqual(f.ids(f.read(task2.id)), ["collaborator", "idobot"]);
  assert.equal(
    f.read(task2.id).queuedInstructions?.[0].sender?.id,
    "collaborator",
  );
});

test("legacy tasks, replayed requests and non-Discord creation retain their existing membership rules", async (t) => {
  const f = await fixture(t);
  const task = f.work.submit(f.request);
  // Simulate a task saved by the previous Engine, including legacy seeding.
  delete task.participantPolicy;
  delete task.memberStates;
  seedParticipants(f.store, task);
  f.store.put("task", task.id, task);
  assert.deepEqual(f.ids(task), [
    "discord-100",
    "discord-200",
    "collaborator",
    "idobot",
  ]);
  assert.deepEqual(f.work.submit(f.request), f.read(task.id));
  const receipt = f.work.control({
    sourcePluginId: "discord",
    taskId: task.id,
    authorId: "discord-200",
    type: "instruction",
    instruction: "Legacy instruction",
    requestKey: "legacy-control",
  });
  assert.equal(
    f.read(task.id).queuedInstructions?.[0].sender?.id,
    receipt.authorId,
  );
  const before = f.read(task.id);
  f.restart();
  assert.deepEqual(f.read(task.id), before);
  for (const [authorId, createdByBot] of [
    ["client-worker", false],
    ["client-worker", true],
    ["discord-100", false],
  ] as const) {
    const direct = new Tasks(f.store).createTask({
      projectId: f.project.id,
      meetingId: f.request.meetingId,
      authorId,
      createdByBot,
      requestId: `${authorId}-${createdByBot}`,
      text: "Direct task",
      network: false,
    });
    assert.equal(direct.participantPolicy, undefined);
    assert.ok(f.ids(direct).includes(authorId.replace(/^client-/, "")));
  }
});

test("UUID and linked Discord actors are recognized by input route, while direct account controls remain human", async (t) => {
  const f = await fixture(t);
  const { Identities } = await import("../src/management/identities.js");
  const identities = new Identities(f.store);
  const anonymous = identities.resolve("discord", "300")!;
  const linked = f.store.createUser(
    "Linked member",
    "fixture-password",
    "member",
  );
  identities.link("discord", "400", linked.id);
  for (const actor of [anonymous, identities.resolve("discord", "400")!]) {
    assert.ok(!actor.id.startsWith("discord-"));
    const task = f.work.submit({
      ...f.request,
      authorId: actor.id,
      requestKey: actor.id,
    });
    assert.equal(task.participantPolicy, "execution");
    assert.deepEqual(f.ids(task), ["idobot"]);
    f.work.control({
      sourcePluginId: "discord",
      taskId: task.id,
      authorId: actor.id,
      type: "instruction",
      instruction: "Discord instruction",
      requestKey: "discord",
    });
    assert.deepEqual(f.ids(f.read(task.id)), ["idobot"]);
    assert.equal(f.read(task.id).queuedInstructions?.[0].sender?.id, "idobot");
    const current = f.read(task.id);
    delete current.memberStates;
    seedParticipants(f.store, current);
    assert.deepEqual(current.memberStates, {});
    f.tasks.control(task.id, actor.id, "steer", "Direct account instruction");
    assert.ok(f.ids(f.read(task.id)).includes(actor.id));
    assert.equal(f.read(task.id).queuedInstructions?.[1].sender?.id, actor.id);
  }
});
