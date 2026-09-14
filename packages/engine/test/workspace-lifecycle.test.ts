import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Task, Project } from "@ido/common/contracts/protocol";
import { Store } from "../src/adapters/sqlite/store.js";
import { Projects } from "../src/processing/projects/service.js";
import { ProjectTeam } from "../src/processing/projects/team.js";
import {
  WorkspaceLifecycle,
  type Deletion,
} from "../src/processing/projects/lifecycle.js";
import {
  seedParticipants,
  taskParticipants,
} from "../src/processing/projects/task-participants.js";
import { Tasks } from "../src/processing/tasks/service.js";
import { createWorkPort } from "../src/processing/tasks/work.js";
import { CoordinatedConversation } from "../src/processing/coordinator/session.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ido-membership-"));
  const store = new Store(directory);
  const cleanups: Array<() => Promise<void>> = [];
  t.after(async () => {
    for (const cleanup of cleanups) await cleanup();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.put("plugin:fixture", "nullable-record", null);
  const admin = store.createUser("admin", "fixture-password", "admin");
  const user = store.createUser("member", "fixture-password", "member");
  const team = new ProjectTeam(store),
    projects = new Projects(store),
    tasks = new Tasks(store);
  projects.ensure();
  for (const id of ["a", "b", "c"]) {
    store.put("device", id, {
      id,
      lifecycleVersion: 1,
      userId: user.id,
      publicKey: "fixture",
      name: id,
      revoked: false,
      generation: 1,
      slots: 1,
      grants: [],
      lastAssigned: 0,
    });
    team.profile(id, { name: id });
  }
  const project = projects.create("Project", "create-project");
  team.own("a", project.id);
  team.join("b", project.id);
  team.join("c", project.id);
  const meetingId = projects.current(project.id).meetingId;
  const create = (requestId = "request", authorId = "client-a") =>
    tasks.createTask({
      projectId: project.id,
      meetingId,
      authorId,
      text: "private task payload",
      requestId,
      network: false,
      createdByBot: true,
    });
  const actor = (deviceId: string) => ({ deviceId, valid: () => true });
  const lifecycle = new WorkspaceLifecycle(store);
  const version = (task: Task) => ({
    revision: task.revision,
    controlVersion: task.controlVersion ?? 0,
    membershipVersion: task.membershipVersion ?? 0,
    confirm: true,
  });
  return {
    store,
    team,
    projects,
    tasks,
    project,
    meetingId,
    create,
    actor,
    lifecycle,
    version,
    admin,
    user,
    cleanups,
  };
}

test("owner transfer precedes exit; exit retains all resources, permits valid invite rejoin, and default profile cannot autojoin", async (t) => {
  const f = await fixture(t);
  const { store, team, project, create, lifecycle, actor } = f;
  const task = create();
  const invitation = team.invite("b", project.id);
  assert.throws(
    () => team.leave("a", project.id, 0),
    /OWNER_TRANSFER_REQUIRED/,
  );
  assert.throws(
    () => team.transfer("b", project.id, "c", 0),
    /PROJECT_OWNER_REQUIRED/,
  );
  assert.throws(
    () => team.transfer("a", project.id, "missing", 0),
    /DEVICE_APPROVAL_REQUIRED/,
  );
  const transferred = team.transfer("a", project.id, "b", 0);
  assert.throws(() => team.leave("a", project.id, 0), /WORKSPACE_CONFLICT/);
  team.leave("a", project.id, transferred.membershipVersion);
  assert.ok(store.get("project", project.id));
  assert.ok(store.get("task", task.id));
  assert.ok(store.get("meeting", task.meetingId));
  assert.ok(!team.projects("a").some((p) => p.id === project.id));
  assert.equal(store.get<Task>("task", task.id)?.memberStates?.a, false);
  team.profile("a", { name: "renamed" });
  assert.ok(!team.projects("a").some((p) => p.id === project.id));
  team.joinInvitation("a", invitation.token);
  assert.ok(team.projects("a").some((p) => p.id === project.id));
  assert.equal(store.get<Task>("task", task.id)?.memberStates?.a, false);
  assert.deepEqual(store.get<any>("device", "a").grants, []);
  team.leave("a", "default", 0);
  team.profile("a", { name: "again" });
  assert.ok(!team.projects("a").some((p) => p.id === "default"));
  team.joinInvitation("a", team.issueInvite("default").token);
  assert.ok(team.projects("a").some((p) => p.id === "default"));
  await assert.rejects(
    lifecycle.deleteProject({ user: f.admin, valid: () => true }, "default", {
      name: "デフォルト",
      membershipVersion: 0,
      confirm: true,
    }),
    /DEFAULT_PROJECT_DELETE_FORBIDDEN/,
  );
  assert.throws(
    () => lifecycle.membership(actor("missing"), task.id, true, 0),
    /DEVICE_APPROVAL_REQUIRED/,
  );
});

test("last human may exit a running task without stopping it; explicit exits survive controls, results, seeding and restart", async (t) => {
  const f = await fixture(t),
    { store, tasks, create, actor, lifecycle, version } = f;
  let task = create();
  task.clientId = "a";
  task.state = "running";
  store.put("task", task.id, task);
  task = lifecycle.membership(
    actor("a"),
    task.id,
    false,
    task.membershipVersion ?? 0,
  );
  assert.deepEqual(
    taskParticipants(store, task).map((p) => p.id),
    ["idobot"],
  );
  assert.equal(task.state, "running");
  tasks.control(task.id, "client-a", "steer", "new instruction");
  tasks.updateResult("a", 1, {
    v: 1,
    type: "result",
    taskId: task.id,
    runId: task.runId,
    revision: 1,
    state: "running",
    progress: "progress",
  });
  const saved = store.get<Task>("task", task.id)!;
  seedParticipants(store, saved);
  assert.equal(saved.memberStates?.a, false);
  assert.equal(saved.state, "running");
  assert.throws(
    () => f.team.leave("c", f.project.id, 0 + 99),
    /WORKSPACE_CONFLICT/,
  );
  await assert.rejects(
    lifecycle.deleteTask(actor("a"), task.id, version(saved)),
    /TASK_ACTIVE/,
  );
  assert.throws(
    () => f.team.leave("a", f.project.id, 0),
    /OWNER_TRANSFER_REQUIRED/,
  );
  const project = f.team.transfer("a", f.project.id, "b", 0);
  assert.throws(
    () => f.team.leave("a", f.project.id, project.membershipVersion),
    /PROJECT_TASKS_ACTIVE/,
  );
  const joined = lifecycle.membership(
    actor("a"),
    task.id,
    true,
    saved.membershipVersion ?? 0,
  );
  assert.ok(joined.participants.some((p) => p.id === "a"));
  assert.throws(
    () =>
      lifecycle.membership(
        actor("a"),
        task.id,
        false,
        saved.membershipVersion ?? 0,
      ),
    /WORKSPACE_CONFLICT/,
  );
});

test("delete checks creator/owner/admin and confirmation, revalidates after async reset, and tombstones block late results and retries", async (t) => {
  const f = await fixture(t),
    { store, create, lifecycle, actor, version, tasks } = f;
  let task = create();
  await assert.rejects(
    lifecycle.deleteTask(actor("c"), task.id, version(task)),
    /PERMISSION_DENIED/,
  );
  await assert.rejects(
    lifecycle.deleteTask(actor("a"), task.id, {
      ...version(task),
      confirm: false,
    }),
    /DELETE_CONFIRMATION_REQUIRED/,
  );
  assert.ok(store.get("task", task.id));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const racing = new WorkspaceLifecycle(store, async () => gate);
  const deletion = racing.deleteTask(actor("a"), task.id, version(task));
  assert.throws(
    () => tasks.control(task.id, "client-a", "stop"),
    /WORKSPACE_CONFLICT/,
  );
  assert.throws(() => create("racing-create"), /WORKSPACE_CONFLICT/);
  task.clientId = "a";
  task.state = "running";
  store.put("task", task.id, task);
  release();
  await assert.rejects(deletion, /TASK_ACTIVE/);
  assert.ok(store.get("task", task.id));
  task.state = "completed";
  store.put("task", task.id, task);
  store.enqueue("a", {
    type: "retry",
    taskId: task.id,
    runId: task.runId,
    task,
  });
  await lifecycle.deleteTask(actor("a"), task.id, version(task));
  assert.equal(store.get("task", task.id), undefined);
  assert.throws(() => create(), /TASK_DELETED/);
  assert.equal(
    tasks.updateResult("a", 1, {
      v: 1,
      type: "result",
      taskId: task.id,
      runId: task.runId,
      revision: 1,
      state: "completed",
      result: "old result",
    }),
    false,
  );
  assert.throws(() => store.put("task", task.id, task), /RESOURCE_DELETED/);
  assert.ok(store.pending("a").every((c) => c.type === "task.purge"));
  assert.ok(!JSON.stringify(store.entries()).includes("private task payload"));
  const command = store.pending("a")[0];
  lifecycle.acknowledge("a", command.id!);
  assert.ok(
    !store
      .get<Deletion>("task-deletion", task.id)
      ?.pendingDeviceIds.includes("a"),
  );
  const owned = create("owner-delete", "client-c");
  await lifecycle.deleteTask(actor("a"), owned.id, version(owned));
  const managed = create("admin-delete", "client-c");
  await lifecycle.deleteTask(
    { user: f.admin, valid: () => true },
    managed.id,
    version(managed),
  );
});

test("AI deletion drops known outputs, pending results, response caches and handles; preserved originals rebuild context without legacy generated text", async (t) => {
  const f = await fixture(t),
    { store, create, actor, version, meetingId, project } = f;
  const task = create(),
    surviving = create("survivor");
  store.put("message", "source", {
    id: "source",
    meetingId,
    authorId: "client-a",
    text: "shared original",
    stage: "completed",
    at: 1,
    replyText: "task-generated output",
  });
  store.put("conversation-output", "known", {
    id: "known",
    meetingId,
    taskIds: [task.id],
    sourceIds: ["source"],
    text: "task-generated output",
    at: 2,
    delivered: true,
  });
  store.put("conversation-output", "legacy", {
    id: "legacy",
    meetingId,
    text: "legacy generated secret",
    at: 3,
    delivered: true,
  });
  store.put("coordinator", meetingId, {
    mode: "text-speech",
    modeRevision: 0,
    completed: [],
    inbox: {
      handle: { threadId: "old-model-session" },
      pending: [
        {
          id: "result",
          type: "task_result",
          taskId: task.id,
          text: "deleted result",
        },
        {
          id: "other",
          type: "task_result",
          taskId: surviving.id,
          text: "surviving result",
        },
        {
          id: "generated",
          type: "assistant_output",
          text: "old generated context",
        },
      ],
      active: {
        id: "batch",
        status: "response",
        events: [
          {
            id: "result",
            type: "task_result",
            taskId: task.id,
            text: "deleted result",
          },
        ],
        response: { reply: { text: "cached model result" } },
      },
    },
  });
  const coordinated = new CoordinatedConversation(store, {
    coordinator: {
      createCoordinator: async () => ({
        run: async () => ({ reply: null, tasks: [], controls: [] }),
        steer: async () => false,
        interrupt: async () => {},
        close: async () => {},
      }),
    },
    work: createWorkPort({ repository: store, tasks: f.tasks }),
    synthesize: async () => "",
    publish: () => {},
  });
  f.cleanups.push(() => coordinated.close());
  const lifecycle = new WorkspaceLifecycle(store, (projectId) =>
    coordinated.resetProject(projectId),
  );
  await lifecycle.deleteTask(actor("a"), task.id, version(task));
  assert.equal(store.get("conversation-output", "known"), undefined);
  assert.ok(store.get("conversation-output", "legacy"));
  assert.equal(store.get<any>("message", "source").text, "shared original");
  assert.equal(store.get<any>("message", "source").replyText, undefined);
  const saved = store.get<any>("coordinator", meetingId);
  assert.equal(saved.inbox.handle, undefined);
  assert.equal(saved.inbox.active, undefined);
  assert.deepEqual(
    saved.inbox.pending.map((e: any) => e.id),
    ["other"],
  );
  const observation = coordinated.session(meetingId).observation([]);
  assert.ok(observation.context?.includes("shared original"));
  assert.ok(!JSON.stringify(observation).includes("legacy generated secret"));
  assert.ok(!JSON.stringify(observation).includes(task.id));
  assert.ok(JSON.stringify(observation).includes(surviving.id));
  assert.ok(store.get("project", project.id));
});

test("project deletion cascades only owned resources and preserves unrelated projects; owner alone cannot delete", async (t) => {
  const f = await fixture(t),
    { store, create, actor, version, project, lifecycle, team } = f;
  const task = create();
  team.invite("c", project.id);
  store.put("speech-assembly", `${f.meetingId}:capture`, {
    id: `${f.meetingId}:capture`,
    parts: { 0: { text: "project-private audio" } },
  });
  const other = f.projects.create("Other", "other");
  await assert.rejects(
    lifecycle.deleteProject(actor("a"), project.id, {
      name: project.name,
      membershipVersion: 0,
      confirm: true,
    }),
    /PERMISSION_DENIED/,
  );
  await assert.rejects(
    lifecycle.deleteProject({ user: f.admin, valid: () => true }, project.id, {
      name: "wrong",
      membershipVersion: 0,
      confirm: true,
    }),
    /DELETE_CONFIRMATION_REQUIRED/,
  );
  task.state = "completed";
  task.controlReceipts = {
    stop: { id: "stop", type: "stop", delivery: "uncertain" } as any,
  };
  store.put("task", task.id, task);
  await assert.rejects(
    lifecycle.deleteProject({ user: f.admin, valid: () => true }, project.id, {
      name: project.name,
      membershipVersion: 0,
      confirm: true,
    }),
    /PROJECT_TASKS_ACTIVE/,
  );
  task.controlReceipts = {};
  store.put("task", task.id, task);
  await lifecycle.deleteProject(
    { user: f.admin, valid: () => true },
    project.id,
    { name: project.name, membershipVersion: 0, confirm: true },
  );
  for (const kind of ["project-member", "project-invite", "meeting", "task"])
    assert.ok(!store.list<any>(kind).some((v) => v.projectId === project.id));
  assert.equal(store.get("project", project.id), undefined);
  assert.ok(store.get("project", other.id));
  assert.ok(!JSON.stringify(store.entries()).includes("project-private audio"));
  assert.throws(
    () => f.projects.create(project.name, "create-project"),
    /PROJECT_DELETED/,
  );
  assert.throws(
    () =>
      store.put("meeting", f.meetingId, {
        id: f.meetingId,
        projectId: project.id,
        messages: [],
      }),
    /RESOURCE_DELETED/,
  );
});

test("deletion invalidates saved AI sessions even when coordination is disabled", async (t) => {
  const { store, create, lifecycle, actor, version, meetingId } =
    await fixture(t);
  const task = create();
  store.put("coordinator", meetingId, {
    mode: "text-speech",
    inbox: {
      handle: { threadId: "saved-private-model-session" },
      pending: [
        {
          id: "result",
          type: "task_result",
          taskId: task.id,
          text: "saved private result",
        },
      ],
      active: {
        id: "batch",
        status: "response",
        events: [],
        response: { reply: { text: "saved private output" } },
      },
    },
  });
  await lifecycle.deleteTask(actor("a"), task.id, version(task));
  const saved = store.get<any>("coordinator", meetingId);
  assert.equal(saved.inbox.handle, undefined);
  assert.equal(saved.inbox.active, undefined);
  assert.deepEqual(saved.inbox.pending, []);
  assert.ok(!JSON.stringify(saved).includes("private"));
});
