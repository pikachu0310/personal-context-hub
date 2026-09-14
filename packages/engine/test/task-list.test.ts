import assert from "node:assert/strict";
import test from "node:test";
import { taskSnapshot } from "../src/adapters/client-ws/task-list.js";
import type { Repository } from "../src/ports/repository.js";
import type { Task } from "@ido/common/contracts/protocol";

test("shared task summaries bound payloads and exclude private execution fields", () => {
  const tasks = Array.from({ length: 205 }, (_, n) => ({
    id: `task-${n}`,
    runId: `run-${n}`,
    revision: 1,
    projectId: "project",
    state: n === 0 ? "running" : "completed",
    clientId: n === 1 ? undefined : "remote",
    updatedAt: n,
    text: "task ".repeat(500),
    progress: "progress ".repeat(500),
    result: "private result",
    history: [{ text: "private history" }],
    controlReceipts: { private: "private receipt" },
  })) as unknown as Task[];
  const store = {
    list: () => tasks,
    get: () => ({
      id: "remote",
      name: "Second PC",
      profile: { name: "Teammate" },
      userId: "user",
      publicKey: "private key material",
      grants: [],
      revoked: false,
    }),
    user: () => ({ name: "Teammate" }),
  } as unknown as Repository;
  const snapshot = taskSnapshot(
    store,
    new Map([["remote", {}]]),
    new Set(["project"]),
  );
  assert.equal(taskSnapshot(store, new Map(), new Set()).tasks.length, 0);
  assert.equal(snapshot.total, 205);
  assert.equal(snapshot.tasks.length, 200);
  assert.equal(snapshot.tasks[0].id, "task-0");
  assert.equal(snapshot.tasks[0].ownerName, "Teammate");
  assert.equal(snapshot.tasks[0].deviceConnected, true);
  assert.ok(
    snapshot.tasks.every(
      (task) => task.title!.length <= 300 && task.progress!.length <= 1000,
    ),
  );
  assert.ok(!JSON.stringify(snapshot).includes("private"));
  tasks[0].clientId = undefined;
  assert.equal(
    taskSnapshot(store, new Map(), new Set(["project"])).tasks[0].deviceName,
    undefined,
  );
});

test("task participants distinguish self, other executors and bot-created work with shared avatar profiles", () => {
  const avatar = "data:image/png;base64,iVBORw0KGgo=";
  const devices = [
    { id: "self", name: "Alex", profile: { name: "Alex", avatar } },
    { id: "other", name: "Sam", profile: { name: "Sam", avatar } },
  ];
  const tasks = [
    {
      id: "mine",
      authorId: "client-self",
      clientId: "self",
      createdByBot: true,
    },
    { id: "theirs", authorId: "client-other", clientId: "other" },
    { id: "collaborative", authorId: "client-self", clientId: "other" },
  ].map((task) => ({
    ...task,
    projectId: "project",
    state: "running",
    updatedAt: 1,
    text: "Task",
  }));
  const store = {
    list: () => tasks,
    get: (kind: string, id: string) =>
      kind === "device"
        ? devices.find((device) => device.id === id)
        : undefined,
  } as unknown as Repository;
  const snapshot = taskSnapshot(store, new Map(), new Set(["project"]));
  assert.deepEqual(
    snapshot.tasks[0].participants?.map((p) => p.name),
    ["Alex", "idobot"],
  );
  assert.deepEqual(
    snapshot.tasks[1].participants?.map((p) => p.name),
    ["Sam"],
  );
  assert.deepEqual(
    snapshot.tasks[2].participants?.map((p) => p.name),
    ["Sam", "Alex"],
  );
  assert.equal(snapshot.profiles?.length, 2);
  assert.ok(snapshot.profiles?.every((p) => p.avatar === avatar));
  assert.ok(
    snapshot.tasks.every((t) => t.participants?.every((p) => !p.avatar)),
  );
  assert.deepEqual(taskSnapshot(store, new Map(), new Set()).profiles, []);
});
