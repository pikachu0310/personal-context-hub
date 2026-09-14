import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/adapters/sqlite/store.js";
import { Projects } from "../src/processing/projects/service.js";
import type { ConversationInput } from "@ido/common/contracts/plugins";
import { PluginBroker } from "../src/adapters/plugins/broker.js";
async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), "ido-projects-"));
  let store = new Store(directory),
    now = 1000;
  let service = new Projects(store, () => now);
  service.ensure();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    get store() {
      return store;
    },
    get service() {
      return service;
    },
    at: (value: number) => (now = value),
    reopen() {
      store.close();
      store = new Store(directory);
      service = new Projects(store, () => now);
      service.ensure();
    },
    accept: (event: Partial<ConversationInput> = {}, origin = "discord") =>
      service.accept(
        {
          eventId: crypto.randomUUID(),
          projectId: "default",
          text: "hello",
          ...event,
        },
        origin,
      ),
  };
}
test("all sources share minutes, exact idle boundary splits once, retries and restarts retain input routes", async (t) => {
  const f = await fixture(t);
  assert.equal(f.store.list("project").length, 1);
  assert.equal(f.store.list("meeting").length, 1);
  const first = f.accept({ eventId: "first" });
  f.at(600999);
  assert.equal(f.accept({}, "dashboard").meetingId, first.meetingId);
  f.at(1200999);
  const next = f.accept({ eventId: "next" }, "activity");
  assert.notEqual(next.meetingId, first.meetingId);
  assert.equal(f.accept({}, "discord").meetingId, next.meetingId);
  f.at(10000000);
  assert.equal(f.store.list("meeting").length, 2);
  assert.equal(f.accept({ eventId: "first" }).meetingId, first.meetingId);
  f.reopen();
  assert.equal(
    f.accept({ eventId: "next" }, "activity").meetingId,
    next.meetingId,
  );
  const resumed = f.accept();
  assert.notEqual(resumed.meetingId, next.meetingId);
  assert.equal(f.store.list("meeting").length, 3);
  assert.equal(f.service.current("default").coordinatorId, first.meetingId);
});
test("long speech and delayed segments stay together; silence and bot activity do not extend idle time", async (t) => {
  const f = await fixture(t);
  const capture = {
    sessionId: "voice",
    utteranceId: "one",
    segmentIndex: 0,
    startedAt: 1000,
  };
  const first = f.accept({
    eventId: "start",
    text: undefined,
    activity: "start",
    capture,
    subject: "alice",
  });
  f.at(1201000);
  assert.equal(f.accept({}, "dashboard").meetingId, first.meetingId);
  f.accept({ text: undefined, activity: "end", capture, subject: "alice" });
  f.at(1801000);
  const next = f.accept();
  assert.notEqual(next.meetingId, first.meetingId);
  assert.equal(
    f.accept({ text: undefined, audio: "audio", capture, subject: "alice" })
      .meetingId,
    first.meetingId,
  );
  const last = f.service.current("default").lastHumanAt;
  f.at(1901000);
  f.accept({
    text: undefined,
    activity: "quiet",
    capture: { ...capture, utteranceId: "quiet" },
  });
  assert.equal(f.service.current("default").lastHumanAt, last);
});
test("legacy IDs resolve to the current project conversation and project creation is idempotent", async (t) => {
  const f = await fixture(t);
  const project = f.service.create("Example", "client:req");
  assert.deepEqual(f.service.create("Example", "client:req"), project);
  assert.throws(
    () => f.service.create("Different", "client:req"),
    /PROJECT_REQUEST_MISMATCH/,
  );
  assert.throws(
    () => f.service.create("example", "other:req"),
    /PROJECT_NAME_EXISTS/,
  );
  const first = f.accept({ projectId: project.id });
  f.at(601000);
  const next = f.accept({ projectId: undefined, meetingId: first.meetingId });
  assert.equal(next.projectId, project.id);
  assert.notEqual(next.meetingId, first.meetingId);
  assert.throws(
    () => f.accept({ projectId: "default", meetingId: first.meetingId }),
    /INPUT_BINDING_MISMATCH/,
  );
  f.store.put("config", "engine", { minutesIdleMinutes: "1" });
  f.at(661000);
  assert.notEqual(
    f.accept({ projectId: project.id }).meetingId,
    next.meetingId,
  );
});
test("project switching preserves accepted speech authorization but fences old delivery and rejects viewers", async (t) => {
  const f = await fixture(t);
  const other = f.service.create("Other", "req");
  f.store.put("config", "discord", { projectId: "default", userPolicy: "all" });
  const plugin = {
    generation: 1,
    revision: 1,
    manifest: {
      capabilities: ["text", "audio", "audio-stream", "project-conversation"],
    },
    request: async (_op: string, data: any) => delivered.push(data),
  };
  const accepted: any[] = [],
    delivered: any[] = [];
  const broker = new PluginBroker(
    f.store,
    () => ({ get: () => plugin, publish: () => {} }) as any,
    {
      handle: async (event: any, context: any) =>
        accepted.push({ event, context }),
    } as any,
    {} as any,
    () => "http://localhost",
  );
  const capture = {
    sessionId: "voice",
    utteranceId: "one",
    segmentIndex: 0,
    startedAt: 1000,
  };
  await broker.request("discord", "input", {
    eventId: "start",
    projectId: "default",
    subject: "100",
    activity: "start",
    capture,
  });
  await broker.request("discord", "projects.select", {
    subject: "100",
    projectId: "other",
  });
  const selected = (await broker.request(
    "discord",
    "projects.current",
    {},
  )) as any;
  assert.equal(selected.project.id, other.id);
  assert.equal(selected.meeting.projectId, other.id);
  await broker.request("discord", "input", {
    eventId: "audio",
    projectId: "default",
    subject: "100",
    audio: "YQ==",
    capture,
  });
  assert.equal(accepted[1].event.meetingId, accepted[0].event.meetingId);
  assert.equal(accepted[1].context.valid(), true);
  await accepted[0].context.deliver({
    kind: "reply",
    eventId: "old",
    content: "old",
  });
  await accepted[1].context.deliver({
    kind: "reply",
    eventId: "old-delayed",
    content: "old",
  });
  assert.equal(delivered.length, 0);
  await broker.request("discord", "input", {
    eventId: "new",
    projectId: other.id,
    subject: "100",
    text: "new",
  });
  await accepted[2].context.deliver({
    kind: "reply",
    eventId: "new",
    content: "new",
  });
  assert.equal(delivered.length, 1);
  const viewer = f.store.createUser("Viewer", "password-long-enough", "viewer");
  f.store.put("external-identity", "discord:200", { userId: viewer.id });
  await assert.rejects(
    broker.request("discord", "projects.select", {
      subject: "200",
      projectId: "default",
    }),
    /PERMISSION_DENIED/,
  );
  await assert.rejects(
    broker.request("discord", "projects.select", {
      subject: "100",
      projectId: "missing",
    }),
    /PROJECT_NOT_FOUND/,
  );
  f.reopen();
  assert.equal(f.store.get<any>("config", "discord").projectId, other.id);
});

test("project names and IDs select existing projects without creating or guessing a project", async (t) => {
  const f = await fixture(t);
  const project = f.service.create("開発 Alpha", "alpha");
  assert.equal(f.service.selectByNameOrId(" 開発 ＡＬＰＨＡ ").id, project.id);
  assert.equal(f.service.selectByNameOrId(project.id).id, project.id);
  assert.equal(f.service.selectByNameOrId("デフォルト").id, "default");
  assert.throws(() => f.service.selectByNameOrId("開発"), /PROJECT_NOT_FOUND/);
  f.store.put("project", "duplicate", { id: "duplicate", name: "開発 alpha" });
  assert.throws(
    () => f.service.selectByNameOrId("開発 Alpha"),
    /PROJECT_NAME_AMBIGUOUS/,
  );
  assert.equal(f.service.selectByNameOrId(project.id).id, project.id);
});

test("conversation plugin startup defaults to the default project, retains selection and recovers a deleted selection", async (t) => {
  const f = await fixture(t);
  const { Plugins } = await import("../src/adapters/plugins/host.js");
  const other = f.service.create("開発", "other");
  const started: any[] = [];
  const manifest = { capabilities: ["project-conversation"], fields: [] };
  const plugin = {
    launch: async () => manifest,
    start: async (config: any) => started.push(config),
  };
  const host = new Plugins(
    "",
    f.store,
    {} as any,
    [{ id: "fixture", package: "fixture", version: "1", builtin: "unused" }],
    async () => {},
    () => {},
  );
  host.get = () => plugin as any;
  await host.start("fixture");
  assert.equal(started[0].projectId, "default");
  f.store.put("config", "fixture", {
    projectId: other.id,
    meetingId: "legacy",
  });
  await host.start("fixture");
  assert.equal(started[1].projectId, other.id);
  assert.equal(started[1].meetingId, undefined);
  f.store.remove("project", other.id);
  await host.start("fixture");
  assert.equal(started[2].projectId, "default");
  assert.equal(f.store.get<any>("config", "fixture").projectId, "default");
});
