import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createConversationEngine } from "../src/engine/conversation.mjs";
import { createStudioController } from "../src/adapters/browser/controller.mjs";
import { startStudioServer } from "../src/runtime/studio-server.mjs";
import { createPreviewRelay } from "../src/runtime/preview-relay.mjs";
import { MeetingStateStore } from "../src/storage/meeting-state.mjs";

const operator = {
  id: "browser:test-operator",
  name: "試す人",
  role: "operator",
};
const waitFor = async (predicate) => {
  for (let count = 0; count < 100; count++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out");
};
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "idd-studio-test-"));
  const store = new MeetingStateStore(join(directory, "meeting.json"), "test");
  await store.acquire();
  const saved = await store.load();
  const executed = [];
  const engine = await createConversationEngine({
    config: {
      voiceMode: "meeting",
      powerMode: true,
      allParticipantsOperate: true,
      observationIntervalMs: 600000,
    },
    store,
    initialState: saved,
    logger: {},
    output: { postText: async () => {} },
    execution: {
      observeMeeting: async () =>
        JSON.stringify({
          minutes: "",
          shouldReply: false,
          tasks: [],
          taskControls: [],
        }),
      runTask: async (task) => {
        executed.push(task.id);
        task.runRevision = (task.runRevision ?? 0) + 1;
        return "成果";
      },
    },
  });
  const controller = createStudioController({
    engine,
    store,
    initialState: saved,
  });
  t.after(async () => {
    await controller.close();
    await engine.session.stop();
    await engine.taskQueue.stop();
    await store.release();
    await rm(directory, { recursive: true, force: true });
  });
  const command = (value) => ({
    id: "unique-command-id-0001",
    meetingId: engine.session.meetingId,
    ...value,
  });
  return { engine, controller, executed, store, command };
}

test("browser commands use the engine queue and durable receipts, including another controller after restart", async (t) => {
  const { controller, engine, executed, command, store } = await fixture(t);
  const create = command({
    type: "create",
    text: "案内をつくる",
    criteria: "スマートフォンで使う\nログイン不要",
  });
  const first = await controller.command(create, operator);
  assert.deepEqual(await controller.command(create, operator), first);
  await waitFor(() => engine.taskQueue.list()[0].state === "completed");
  assert.equal(executed.length, 1);
  assert.deepEqual(controller.snapshot().tasks[0].acceptanceCriteria, [
    "スマートフォンで使う",
    "ログイン不要",
  ]);
  assert.equal("workingDirectory" in controller.snapshot().tasks[0], false);
  const restored = createStudioController({
    engine,
    store,
    initialState: await store.load(),
  });
  assert.deepEqual(await restored.command(create, operator), first);
  assert.deepEqual(
    await restored.command(create, { ...operator, id: "browser:reconnected" }),
    first,
  );
  assert.equal(executed.length, 1);
  await assert.rejects(
    () => controller.command({ ...create, text: "別の内容" }, operator),
    (error) => error.status === 409,
  );
  await assert.rejects(
    () => controller.command(create, { ...operator, role: "viewer" }),
    (error) => error.status === 403,
  );
});

test("a second participant's newer specification rejects stale follow and stop, while retrying accepted follow does not execute twice", async (t) => {
  const { controller, engine, command, executed } = await fixture(t);
  const created = await controller.command(
    command({ type: "create", text: "案内" }),
    operator,
  );
  await waitFor(() => engine.taskQueue.list()[0].state === "completed");
  const taskId = created.taskIds[0];
  const follow = command({
    id: "unique-command-id-follow",
    type: "follow",
    taskId,
    specRevision: 1,
    controlVersion: 0,
    text: "準備中を下へ",
  });
  await controller.command(follow, { ...operator, id: "browser:second" });
  await waitFor(() => engine.taskQueue.list()[0].state === "completed");
  assert.equal(executed.length, 2);
  assert.equal(
    controller.snapshot().tasks[0].instructions[0].text,
    "準備中を下へ",
  );
  await controller.command(follow, { ...operator, id: "browser:second" });
  assert.equal(executed.length, 2);
  await assert.rejects(
    () =>
      controller.command(
        { ...follow, id: "unique-command-id-stale" },
        operator,
      ),
    (error) => error.status === 409,
  );
  await assert.rejects(
    () =>
      controller.command(
        { ...follow, id: "unique-command-id-stop", type: "stop" },
        operator,
      ),
    (error) => error.status === 409,
  );
});

test("conversation input is deduplicated and does not claim a revision it has not shown", async (t) => {
  const { controller, engine, command } = await fixture(t);
  const say = command({ type: "say", text: "スマートフォンで使いたい" });
  await controller.command(say, operator);
  await controller.command(say, operator);
  assert.equal(engine.session.statements.length, 1);
  assert.equal(controller.snapshot().statements[0].speaker, operator.name);
  await assert.rejects(
    () => controller.command({ ...say, meetingId: "old" }, operator),
    (error) => error.status === 409,
  );
});

test("two alternatives have independent task IDs and retry leaves exactly two executions", async (t) => {
  const { controller, engine, command, executed } = await fixture(t);
  const variants = command({
    type: "variants",
    text: "案内",
    variantA: "一覧",
    variantB: "地図",
  });
  const result = await controller.command(variants, operator);
  assert.equal(new Set(result.taskIds).size, 2);
  assert.deepEqual(await controller.command(variants, operator), result);
  await waitFor(() =>
    engine.taskQueue.list().every((task) => task.state === "completed"),
  );
  assert.equal(executed.length, 2);
});

test("Studio login binds server identity; viewer, forged origin and unauthenticated operations fail", async (t) => {
  const { controller, command } = await fixture(t);
  const operatorCode = "operator-code-".repeat(4),
    viewerCode = "viewer-code-".repeat(4);
  const server = await startStudioServer({
    port: 0,
    operatorCode,
    viewerCode,
    rooms: new Map([["demo", { name: "案内", controller }]]),
  });
  t.after(() => server.close());
  const origin = new URL(server.url).origin;
  const post = (path, input, token, headers = {}) =>
    fetch(origin + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: JSON.stringify(input),
    });
  assert.equal((await fetch(origin + "/api/studio/rooms")).status, 401);
  const login = await (
    await post("/api/studio/login", {
      name: "共同制作者",
      code: operatorCode,
      role: "viewer",
      id: "forged",
    })
  ).json();
  assert.equal(login.actor.role, "operator");
  assert.notEqual(login.actor.id, "forged");
  assert.equal(
    (
      await post(
        "/api/studio/rooms/demo/commands",
        command({ type: "say", text: "発言" }),
        login.token,
        { Origin: "https://attacker.invalid" },
      )
    ).status,
    403,
  );
  const view = await (
    await post("/api/studio/login", { code: viewerCode })
  ).json();
  assert.equal(
    (
      await post(
        "/api/studio/rooms/demo/commands",
        command({ type: "create", text: "作業", role: "operator" }),
        view.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(origin + "/api/studio/rooms/demo/snapshot", {
        headers: { Authorization: `Bearer ${view.token}` },
      })
    ).status,
    200,
  );
  const valid = await post(
    "/api/studio/rooms/demo/commands",
    command({ type: "say", text: "発言" }),
    login.token,
  );
  assert.equal(valid.status, 200);
  assert.equal(controller.snapshot().statements[0].speaker, "共同制作者");
});

test("preview uses another origin, gates requests by capability and revokes a superseded revision", async (t) => {
  const upstream = createServer((req, res) =>
    res
      .writeHead(200, { "Content-Type": "text/html" })
      .end(`<p>${req.url}</p>`),
  );
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        upstream.close(resolve);
        upstream.closeAllConnections();
      }),
  );
  const relay = createPreviewRelay();
  t.after(() => relay.close());
  const task = {
    id: "preview-test",
    runRevision: 1,
    specRevision: 1,
    preview: {
      state: "available",
      runRevision: 1,
      specRevision: 1,
      url: `http://127.0.0.1:${upstream.address().port}/`,
    },
  };
  await relay.expose(task);
  const shared = task.preview.sharedUrl;
  assert.notEqual(new URL(shared).origin, new URL(task.preview.url).origin);
  assert.equal((await fetch(new URL("/", shared))).status, 403);
  const login = await fetch(shared, { redirect: "manual" });
  assert.equal(login.status, 303);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const response = await fetch(new URL("/assets/app.js", shared), {
    headers: { Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /\/assets\/app.js/);
  task.specRevision = 2;
  assert.equal(
    (await fetch(new URL("/", shared), { headers: { Cookie: cookie } })).status,
    410,
  );
});
