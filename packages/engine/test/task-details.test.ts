import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/adapters/sqlite/store.js";
import { WorkspaceLifecycle } from "../src/processing/projects/lifecycle.js";
import { Tasks } from "../src/processing/tasks/service.js";
import {
  TaskDetails,
  DETAIL_CHUNK_BYTES,
} from "../src/processing/tasks/details.js";
import { Client } from "../../client/src/bootstrap/client.js";
import { detailSnapshot } from "../../client/src/connection/task-details.js";
import type {
  TaskDetailSnapshot,
  TaskDetailRead,
} from "@ido/common/contracts/api";
import type { Run } from "../../client/src/execution/executor.js";

function chunks(snapshot: TaskDetailSnapshot) {
  const bytes = Buffer.from(JSON.stringify(snapshot));
  const digest = createHash("sha256").update(bytes).digest("hex");
  const total = Math.ceil(bytes.length / DETAIL_CHUNK_BYTES);
  return Array.from({ length: total }, (_, index) => ({
    taskId: snapshot.taskId,
    runId: snapshot.runId,
    revision: snapshot.revision,
    sequence: snapshot.sequence,
    total,
    index,
    digest,
    data: bytes
      .subarray(index * DETAIL_CHUNK_BYTES, (index + 1) * DETAIL_CHUNK_BYTES)
      .toString("base64"),
  }));
}
function read(service: TaskDetails, taskId: string): TaskDetailRead {
  const parts: Buffer[] = [];
  let offset = 0,
    token: string | undefined;
  do {
    const page = service.read("viewer", { taskId, offset, token }, new Map());
    parts.push(Buffer.from(page.data, "base64"));
    token = page.token;
    if (page.nextOffset === undefined) break;
    offset = page.nextOffset;
  } while (true);
  return JSON.parse(Buffer.concat(parts).toString());
}
test("details persist completed histories, atomically assemble chunks, fence writers and reject malformed payloads", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-detail-store-"));
  let store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  store.put("project", "project", { id: "project", name: "Demo", remote: "" });
  for (const deviceId of ["owner", "viewer"]) {
    store.put("device", deviceId, {
      id: deviceId,
      generation: 1,
      revoked: false,
      grants: [],
    });
    store.put("project-member", `project:${deviceId}`, {
      projectId: "project",
      deviceId,
    });
  }
  const task = new Tasks(store).createTask({
    projectId: "project",
    meetingId: "meeting",
    authorId: "user",
    requestId: "test",
    text: "明日の天気",
    network: false,
  });
  task.state = "completed";
  task.clientId = "owner";
  task.result = "晴れ";
  store.put("task", task.id, task);
  const client = new Client(directory);
  client.settings.deviceId = "owner";
  const value: Run = {
    task,
    state: "completed",
    directory,
    result: "晴れ",
    detailSync: {
      engineUrl: "https://example.invalid",
      deviceId: "owner",
      sequence: 1,
    },
    activity: [
      {
        id: "1:reply",
        revision: 1,
        at: 1,
        updatedAt: 1,
        kind: "message",
        title: "結果",
        text: "回答",
      },
    ],
    detailResources: { patch: "変更あ".repeat(60000), patchAt: 1 },
  };
  let service = new TaskDetails(store);
  assert.equal(read(service, task.id).snapshot, undefined);
  const snapshot = detailSnapshot(client, value, task.id);
  const frames = chunks(snapshot);
  assert.ok(frames.length > 1);
  assert.ok(
    frames.every(
      (frame) => Buffer.byteLength(JSON.stringify(frame)) < 256 * 1024,
    ),
  );
  assert.throws(() => service.sync("viewer", 1, frames[0]), /ASSIGNMENT/);
  assert.throws(() => service.sync("owner", 0, frames[0]), /ASSIGNMENT/);
  assert.throws(
    () => service.sync("owner", 1, { ...frames[0], revision: 2 }),
    /ASSIGNMENT/,
  );
  for (const frame of frames.slice(1).reverse())
    service.sync("owner", 1, frame);
  assert.equal(read(service, task.id).snapshot, undefined);
  assert.equal(service.sync("owner", 1, frames[0]).complete, true);
  assert.equal(service.sync("owner", 1, frames[0]).complete, true);
  assert.equal(read(service, task.id).snapshot?.patch, snapshot.patch);
  assert.equal(read(service, task.id).ownerConnected, false);
  assert.equal(store.get<any>("task", task.id).state, "completed");
  const oldPage = service.read("viewer", { taskId: task.id }, new Map());
  const next = { ...snapshot, sequence: 2, plan: "next", capturedAt: 5 };
  for (const frame of chunks(next)) service.sync("owner", 1, frame);
  assert.equal(
    service.read(
      "viewer",
      { taskId: task.id, offset: oldPage.nextOffset, token: oldPage.token },
      new Map(),
    ).token,
    oldPage.token,
  );
  service.sync("owner", 1, frames[0]);
  assert.equal(read(service, task.id).snapshot?.sequence, 2);
  for (const frame of chunks({
    ...next,
    sequence: 3,
    activity: {
      ...next.activity,
      entries: [{ ...next.activity.entries[0], text: {} as string }],
    },
  })) {
    if (frame.index === frame.total - 1)
      assert.throws(() => service.sync("owner", 1, frame), /INVALID_DETAIL/);
    else service.sync("owner", 1, frame);
  }
  assert.equal(read(service, task.id).snapshot?.sequence, 2);
  store.close();
  store = new Store(directory);
  service = new TaskDetails(store);
  assert.equal(read(service, task.id).snapshot?.plan, "next");
  store.remove("project-member", "project:viewer");
  assert.throws(() => read(service, task.id), /INVITATION/);
  const admin = store.createUser("admin", "fixture-password-long", "admin");
  await new WorkspaceLifecycle(store).deleteTask(
    { user: admin, valid: () => true },
    task.id,
    {
      confirm: true,
      revision: task.revision,
      controlVersion: 0,
      membershipVersion: task.membershipVersion ?? 0,
    },
  );
  assert.equal(store.get("task-detail", task.id), undefined);
  assert.throws(() => service.sync("owner", 1, frames[0]), /TASK_NOT_FOUND/);
});
