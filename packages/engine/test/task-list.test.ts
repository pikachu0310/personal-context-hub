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
      userId: "user",
      publicKey: "private key material",
      grants: [],
      revoked: false,
    }),
    user: () => ({ name: "Teammate" }),
  } as unknown as Repository;
  const snapshot = taskSnapshot(store, new Map([["remote", {}]]));
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
  assert.equal(taskSnapshot(store, new Map()).tasks[0].deviceName, undefined);
});
