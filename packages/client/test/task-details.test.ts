import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "../src/bootstrap/client.js";
import { detailSnapshot } from "../src/connection/task-details.js";
import { parseTaskDetail, taskProgress } from "@ido/common/contracts/api";
import type { Task } from "@ido/common/contracts/protocol";
const task = (): Task => ({
  id: "task",
  runId: "run",
  revision: 1,
  requestId: "request",
  projectId: "project",
  meetingId: "meeting",
  authorId: "user",
  text: "依頼",
  state: "running",
  network: false,
  createdAt: 1,
  updatedAt: 1,
  history: [],
});
import type { Run } from "../src/execution/executor.js";
test("detail projection includes every display kind and excludes execution internals and credentials", () => {
  const client = new Client("/tmp/fixture");
  client.settings.deviceId = "owner";
  const value: Run = {
    task: task(),
    directory: "/tmp/work",
    state: "running",
    threadId: "private-thread-handle",
    accessMode: "sandbox",
    plan: "plan",
    detailSync: {
      engineUrl: "https://private-engine.invalid",
      deviceId: "owner",
      sequence: 1,
    },
    contextSources: [
      {
        id: "profile",
        title: "ユーザー情報",
        kind: "profile",
        text: "API_KEY=fixture-secret",
      },
    ],
    detailResources: {
      patch: "token=fixture-secret",
      environment: { directory: "/tmp/work", deviceName: "executor" },
    },
  };
  client.executor.approvals.set("approval", {
    runId: value.task.runId,
    method: "command/approval",
    params: { command: "echo approved", token: "fixture-secret" },
    timer: null!,
    resolve: () => {},
  });
  const snapshot = detailSnapshot(client, value, value.task.id);
  assert.equal(snapshot.approvals[0].method, "command/approval");
  assert.deepEqual(snapshot.approvals[0].params, {
    command: "echo approved",
    token: "[credential hidden]",
  });
  const encoded = JSON.stringify(snapshot);
  assert.ok(!encoded.includes("private-thread-handle"));
  assert.ok(!encoded.includes("private-engine.invalid"));
  assert.ok(!encoded.includes("fixture-secret"));
  assert.equal(snapshot.plan, "plan");
  assert.equal(snapshot.run.accessMode, "sandbox");
  assert.equal(snapshot.environment?.deviceName, "executor");
  assert.deepEqual(parseTaskDetail(snapshot), snapshot);
  assert.equal(taskProgress("turn.completed", "completed"), "完了");
  assert.equal(taskProgress("計画の確認待ち", "running"), "計画の確認待ち");
});

test("sync includes registered local mirrors but never private tasks or another Engine's outbox", async (t) => {
  const client = new Client("/tmp/fixture");
  client.settings.deviceId = "owner";
  client.settings.engineUrl = "https://team.example.invalid";
  client.settings.projects = [{ id: "project", name: "Demo", remote: "" }];
  client.connected = true;
  client.details.supported = true;
  t.mock.method(client.executor, "save", async () => {});
  t.mock.method(client.details, "resources", async () => {});
  const calls: Array<{ operation: string; input: Record<string, unknown> }> =
    [];
  client.workspaceRequest = async <T>(
    operation: string,
    input: Record<string, unknown>,
  ) => {
    calls.push({ operation, input });
    return { sequence: 0, complete: true } as T;
  };
  const make = (id: string): Run => ({
    task: { ...task(), id, runId: id },
    state: "completed",
    origin: "local",
    directory: "/tmp/work",
    detailResources: { environmentAt: 1 },
    detailSync: {
      engineUrl: client.settings.engineUrl!,
      deviceId: "owner",
      sequence: 0,
      resourceKey: "1:completed",
    },
  });
  client.executor.runs.private = make("private");
  client.executor.runs.shared = {
    ...make("shared"),
    discordShare: {
      taskId: "mirror",
      projectId: "project",
      engineUrl: client.settings.engineUrl!,
      deviceId: "owner",
      sequence: 1,
      status: "synced",
    },
  };
  client.executor.runs.foreign = {
    ...make("foreign"),
    detailSync: {
      engineUrl: "https://other.example.invalid",
      deviceId: "owner",
      sequence: 0,
    },
    origin: undefined,
  };
  await client.details.sync();
  assert.ok(calls.some((c) => c.operation === "task.detail.sync"));
  assert.ok(calls.every((c) => c.input.taskId === "mirror"));
  const upload = calls.find((c) => c.operation === "task.detail.sync")!;
  const snapshot = JSON.parse(
    Buffer.from(String(upload.input.data), "base64").toString(),
  );
  assert.equal(snapshot.run.task.id, "mirror");
  assert.equal(snapshot.run.task.authorId, "client-owner");
  assert.ok(!JSON.stringify(snapshot).includes("team.example.invalid"));
});
