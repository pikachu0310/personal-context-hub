import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Engine } from "../src/bootstrap/engine.js";
import { Client } from "../../client/src/bootstrap/client.js";
import { TaskBoard } from "../src/processing/tasks/board.js";
import type { Task } from "@ido/common/contracts/protocol";
import type { Run } from "../../client/src/execution/executor.js";

async function until(check: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("CONDITION_TIMEOUT");
}

test("different Clients discuss engine tasks over authenticated board connections with project and run fences", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-board-connection-"));
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
    await Promise.all(clients.map((client) => client.close()));
    await engine.close();
    await rm(directory, { recursive: true, force: true });
  });
  await engine.listen();
  for (const deviceId of ["a", "b"]) {
    const client = new Client(join(directory, deviceId));
    clients.push(client);
    client.credentials.backend = "file";
    t.mock.method(client, "checkAccount", async () => {
      client.loginStatus = "authenticated";
    });
    await client.start(0);
    engine.store.put("device", deviceId, {
      id: deviceId,
      name: deviceId,
      userId: user.id,
      publicKey: client.settings.publicKey,
      revoked: false,
      generation: 0,
      slots: 1,
      lastAssigned: 0,
      grants: [],
    });
    client.settings.deviceId = deviceId;
    engine.store.put("project-member", `project:${deviceId}`, {
      projectId: "project",
      deviceId,
    });
    client.settings.engineUrl = engine.origin;
    client.settings.mappings = [
      { projectId: "project", directory, slots: 1, network: false },
    ];
    client.allowedProjects.add("project");
    client.executor.execute = async (value: Run) => {
      value.state = "running";
      client.executor.report(value);
    };
    await client.connect();
  }
  await until(() => engine.ready.size === 2);
  const tasks = ["API", "UI"].map((name) =>
    engine.tasks.createTask({
      projectId: "project",
      meetingId: "meeting",
      authorId: user.id,
      text: name,
      requestId: name,
      network: false,
    }),
  );
  engine.flush();
  await until(() =>
    tasks.every(
      (task) => engine.store.get<Task>("task", task.id)?.state === "running",
    ),
  );
  const [a, b] = tasks.map((task) => engine.store.get<Task>("task", task.id)!);
  assert.notEqual(a.clientId, b.clientId);
  const clientA = clients.find(
    (client) => client.settings.deviceId === a.clientId,
  )!;
  const clientB = clients.find(
    (client) => client.settings.deviceId === b.clientId,
  )!;
  assert.equal(clientA.executor.board.supported, true);
  const aPort = clientA.executor.board.forTask(a, new AbortController().signal);
  const bPort = clientB.executor.board.forTask(b, new AbortController().signal);
  assert.deepEqual(
    await bPort.read({ query: "", limit: null, taskId: null }),
    await bPort.read({}),
  );
  await assert.rejects(
    bPort.read({ limit: 20 }),
    /INVALID_BOARD_LIMIT: limit.*1 to 10/,
  );
  await assert.rejects(
    bPort.read({ query: 123 }),
    /INVALID_BOARD_QUERY: query/,
  );
  await assert.rejects(
    bPort.read({ offset: -1 }),
    /INVALID_BOARD_OFFSET: offset/,
  );
  // Unexpected storage failures must not expose internal details to callers.
  const read = t.mock.method(TaskBoard.prototype, "read", () => {
    throw new Error("private storage failure");
  });
  await assert.rejects(bPort.read({}), { message: "BOARD_REQUEST_REJECTED" });
  read.mock.restore();
  const first = (await aPort.post(
    { body: "共通APIについて相談" },
    "first",
  )) as any;
  let notices = 0;
  const off = aPort.subscribe(() => notices++);
  t.after(off);
  const input = { taskId: a.id, replyTo: first.id, body: "UI側からの返信" };
  await bPort.post(input, "reply");
  await bPort.post(input, "reply");
  await until(() => notices === 1);
  const discussion = (await bPort.read({ taskId: a.id })) as any;
  assert.deepEqual(
    discussion.posts.map((post: any) => post.authorTaskId),
    [a.id, b.id],
  );
  const forged = clientB.executor.board.forTask(
    a,
    new AbortController().signal,
  );
  await assert.rejects(forged.read({}), /REJECTED/);
  const stale = clientA.executor.board.forTask(
    { ...a, revision: a.revision - 1 },
    new AbortController().signal,
  );
  await assert.rejects(stale.post({ body: "stale" }, "stale"), /REJECTED/);
  engine.store.put("task", "foreign", {
    ...a,
    id: "foreign",
    projectId: "foreign",
  });
  await assert.rejects(bPort.read({ taskId: "foreign" }), /REJECTED/);
  engine.store.put("task", a.id, { ...a, state: "completed" });
  assert.equal(
    ((await bPort.read({ query: "共通API" })) as any).threads.length,
    0,
  );
  assert.equal(((await bPort.read({ taskId: a.id })) as any).posts.length, 2);
  await assert.rejects(aPort.read({}), /REJECTED/);
  engine.store.put("task", a.id, a);
  assert.equal(
    ((await bPort.read({ query: "共通API" })) as any).threads.length,
    1,
  );
  engine.store.remove("project-member", `project:${a.clientId}`);
  await assert.rejects(aPort.read({}), /REJECTED/);
});
