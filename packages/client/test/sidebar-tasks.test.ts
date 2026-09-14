import assert from "node:assert/strict";
import test from "node:test";
import type { ClientState } from "@ido/common/contracts/api";
import type { Task } from "@ido/common/contracts/protocol";
import {
  completionVersion,
  sidebarTasks,
  taskIndicator,
  taskReadKey,
  type SidebarTask,
} from "../src/ui/sidebar-tasks.js";

const task = (id: string, state: Task["state"], updatedAt = 1): Task => ({
  id,
  runId: `run-${id}`,
  revision: 1,
  state,
  updatedAt,
  projectId: "project",
  title: id,
  text: id,
  history: [],
  meetingId: "meeting",
  authorId: "member",
  requestId: id,
  network: false,
  createdAt: 1,
});

test("one chronological task list deduplicates local executions, shared mirrors and project snapshots", () => {
  const local = task("local", "running", 10);
  const remote = task("remote", "completed", 20);
  const queued = task("queue", "queued", 30);
  const state: ClientState = {
    csrf: "fixture",
    settings: { slots: 1, projects: [], mappings: [] },
    status: "connected",
    allow: true,
    loginStatus: "authenticated",
    approvals: [],
    connected: true,
    runs: [
      {
        task: local,
        state: "running",
        directory: "/fixture",
        discordShare: {
          taskId: "mirror",
          projectId: "project",
          status: "synced",
        },
      },
    ],
    teamTasks: {
      updatedAt: 1,
      total: 2,
      tasks: [
        { ...local, id: "mirror", title: "mirror" },
        { ...remote, title: "remote" },
      ],
    },
    projectTasks: [local, remote, queued],
  };
  const items = sidebarTasks(state);
  assert.deepEqual(
    items.map((item) => item.task.id),
    ["queue", "remote", "local"],
  );
  assert.equal(items[2].run, state.runs[0]);
  assert.deepEqual(
    sidebarTasks({ ...state, connected: false, projectTasks: [] }).map(
      (item) => item.task.id,
    ),
    ["local"],
  );
});

test("running uses a spinner, terminal results are unread once per revision, and pending work has no dot", () => {
  const item: SidebarTask = { task: task("one", "queued") };
  assert.equal(taskIndicator(item), undefined);
  item.task.state = "assigned";
  assert.equal(taskIndicator(item), undefined);
  item.task.state = "running";
  assert.equal(taskIndicator(item), "running");
  for (const status of [
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ] as const) {
    item.task.state = status;
    assert.equal(taskIndicator(item), "unread");
    const seen = completionVersion(item);
    assert.equal(taskIndicator(item, seen), undefined);
    item.task.updatedAt++;
    assert.equal(
      taskIndicator(item, seen),
      undefined,
      "Polling/metadata updates must not recreate unread markers",
    );
    item.task.revision++;
    assert.equal(taskIndicator(item, seen), "unread");
  }
  assert.notEqual(
    taskReadKey("account-a", item),
    taskReadKey("account-b", item),
  );
  assert.notEqual(
    taskReadKey("account-a", item),
    taskReadKey("account-a", { task: { ...item.task, projectId: "other" } }),
  );
});
