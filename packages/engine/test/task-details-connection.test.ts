import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/bootstrap/engine.js";
import { Client } from "../../client/src/bootstrap/client.js";
import { recordActivity } from "../../client/src/execution/activity.js";
import type { Run } from "../../client/src/execution/executor.js";
import type { TaskDetailRead } from "@ido/common/contracts/api";
async function until(check: () => boolean) {
  for (let n = 0; n < 500; n++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("CONDITION_TIMEOUT");
}
test("signed-out viewer reads a remote task, backfill, refresh, restart and offline snapshot without execution grants", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-detail-connect-"));
  const engine = new Engine({
    directory: join(directory, "engine"),
    port: 0,
    previewPort: 0,
  });
  engine.credentials.backend = "file";
  const user = engine.store.createUser(
    "operator",
    "fixture-password-long",
    "member",
  );
  engine.store.put("project", "project", {
    id: "project",
    name: "Demo",
    remote: "",
  });
  const clients: Client[] = [];
  t.after(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });
  await engine.listen();
  for (const deviceId of ["owner", "viewer"]) {
    const client = new Client(join(directory, deviceId));
    clients.push(client);
    client.credentials.backend = "file";
    t.mock.method(client, "checkAccount", async () => {
      client.loginStatus = "login required";
    });
    await client.start(0);
    engine.store.put("device", deviceId, {
      id: deviceId,
      name: deviceId,
      userId: user.id,
      publicKey: client.settings.publicKey,
      revoked: false,
      generation: 0,
      grants: [],
      slots: 1,
      lastAssigned: 0,
    });
    engine.store.put("project-member", `project:${deviceId}`, {
      projectId: "project",
      deviceId,
    });
    client.settings.deviceId = deviceId;
    client.settings.engineUrl = engine.origin;
    await client.connect();
  }
  const [owner, viewer] = clients;
  await until(() => owner.connected && viewer.connected);
  assert.equal(viewer.allow, false);
  assert.equal(viewer.loginStatus, "login required");
  assert.equal(viewer.settings.mappings.length, 0);
  const task = engine.tasks.createTask({
    projectId: "project",
    meetingId: "meeting",
    authorId: user.id,
    text: "明日の天気を調べる",
    requestId: "weather",
    network: false,
  });
  task.clientId = "owner";
  task.state = "completed";
  task.result = "明日は晴れです";
  task.progress = "turn.completed";
  engine.store.put("task", task.id, task);
  const value: Run = {
    task,
    state: "completed",
    directory,
    result: task.result,
    progress: task.progress,
    model: "fixture-model",
    contextSources: [
      { id: "context", kind: "context", title: "参考資料", text: "場所は東京" },
    ],
  };
  owner.executor.runs[task.runId] = value;
  recordActivity(value, {
    id: "cmd",
    kind: "command",
    title: "コマンドを実行",
    text: "echo weather",
    output: "sunny\nAPI_KEY=fixture-hidden",
    exitCode: 0,
  });
  recordActivity(value, {
    id: "files",
    kind: "files",
    title: "変更",
    files: [{ path: "weather.txt", kind: "add" }],
  });
  recordActivity(value, {
    id: "answer",
    kind: "message",
    title: "結果",
    text: task.result,
  });
  t.mock.method(owner.executor, "artifact", async () => ({
    patch: "diff --git a/weather.txt b/weather.txt\n+sunny",
    branch: "test",
    revision: 1,
  }));
  await owner.executor.save();
  await until(
    () => !!engine.store.get<any>("task-detail", task.id)?.snapshot.patchAt,
  );
  const response = await fetch(viewer.origin + "/api/task/detail", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": viewer.csrf,
    },
    body: JSON.stringify({ taskId: task.id, projectId: task.projectId }),
  });
  assert.equal(response.status, 200);
  const detail = (await response.json()) as TaskDetailRead;
  assert.deepEqual(
    detail.snapshot?.activity.entries,
    JSON.parse(JSON.stringify(value.activity)),
  );
  assert.equal(detail.snapshot?.run.result, "明日は晴れです");
  assert.equal(detail.snapshot?.run.progress, "完了");
  assert.equal(detail.snapshot?.run.contextSources?.[0].text, "場所は東京");
  assert.ok(detail.snapshot?.patch?.includes("sunny"));
  assert.ok(!JSON.stringify(detail).includes("fixture-hidden"));
  const firstSync = detail.syncedAt!;
  await viewer.workspaceRequest("task.detail.refresh", { taskId: task.id });
  await until(
    () => engine.store.get<any>("task-detail", task.id)?.syncedAt > firstSync,
  );
  task.history.push({
    revision: task.revision,
    text: task.text,
    result: task.result,
  });
  task.revision++;
  task.text = "気温も教えてください";
  task.result = "気温は25度です";
  value.result = task.result;
  recordActivity(value, {
    id: "followup",
    kind: "instruction",
    title: "追加指示",
    text: task.text,
  });
  recordActivity(value, {
    id: "answer",
    kind: "message",
    title: "結果",
    text: task.result,
  });
  engine.store.put("task", task.id, task);
  await owner.executor.save();
  await until(
    () =>
      engine.store.get<any>("task-detail", task.id)?.snapshot.revision === 2,
  );
  const continued = await viewer.details.read(task.id, task.projectId);
  assert.ok(
    continued.snapshot?.activity.entries.some(
      (entry) => entry.revision === 1 && entry.text === "明日は晴れです",
    ),
  );
  assert.ok(
    continued.snapshot?.activity.entries.some(
      (entry) => entry.revision === 2 && entry.text === "気温は25度です",
    ),
  );
  const sequence = value.detailSync!.sequence;
  await owner.executor.load();
  assert.equal(
    owner.executor.runs[task.runId].detailSync?.engineUrl,
    engine.origin,
  );
  await owner.connect();
  await until(
    () =>
      owner.connected &&
      (engine.store.get<any>("task-detail", task.id)?.snapshot.sequence ?? 0) >
        sequence,
  );
  owner.ws?.close();
  await until(() => !owner.connected);
  const offline = await viewer.details.read(task.id, task.projectId);
  assert.equal(offline.ownerConnected, false);
  assert.equal(offline.snapshot?.run.result, "気温は25度です");
  // An older Engine still provides its stored request/result through project.snapshot.
  viewer.details.supported = false;
  assert.equal(
    (await viewer.details.read(task.id, task.projectId)).task.result,
    "気温は25度です",
  );
  viewer.details.supported = true;
  engine.store.remove("project-member", "project:viewer");
  await assert.rejects(
    viewer.details.read(task.id, task.projectId),
    /INVITATION/,
  );
});
