import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { InputContext } from "../../common/src/contracts/plugins.js";
import type { WorkspaceState } from "../../common/src/contracts/api.js";
import { Store } from "../src/adapters/sqlite/store.js";
import { Workspace } from "../src/output/queries/workspace.js";
import { Tasks } from "../src/processing/tasks/service.js";

test("workspace chat projects source-less results and Live transcripts without duplicating direct replies or changing logs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-output-projection-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const user = store.createUser("member", "test-password-long", "member");
  store.put("meeting", "meeting", {
    id: "meeting",
    name: "Meeting",
    summary: "Human log",
    messages: [
      {
        id: "source",
        authorId: user.id,
        text: "Question",
        replyText: "Direct answer",
        at: 10,
        stage: "completed",
      },
    ],
  });
  store.put("meeting", "other", {
    id: "other",
    name: "Other",
    summary: "",
    messages: [],
  });
  store.put("conversation-output", "direct", {
    id: "direct",
    meetingId: "meeting",
    provider: "coordinator",
    text: "Direct answer",
    sourceIds: ["source"],
    at: 11,
  });
  store.put("conversation-output", "result", {
    id: "result",
    meetingId: "meeting",
    provider: "coordinator",
    text: "Verified task result",
    sourceIds: [],
    at: 12,
    deliveryStatus: "unknown",
    playbackStatus: "not_confirmed",
  });
  store.put("conversation-output", "live", {
    id: "live",
    meetingId: "meeting",
    provider: "live",
    text: "Live actual words",
    startedAt: 13,
    playbackStatus: "unknown",
  });
  store.put("conversation-output", "other-result", {
    id: "other-result",
    meetingId: "other",
    provider: "coordinator",
    text: "Other meeting result",
    at: 14,
  });
  const beforeMessages = store.list("message");
  const beforeOutputs = store.list("conversation-output");
  const workspace = new Workspace(
    store,
    new Tasks(store),
    {} as any,
    () => {},
    async () => undefined,
    () => "",
  );
  const context: InputContext = {
    pluginId: "dashboard",
    actor: user,
    valid: () => true,
    deliver: async () => {},
    publish() {},
  };
  const state = (await workspace.request(
    "state",
    {},
    context,
  )) as WorkspaceState;
  const messages = state.meetings.find(
    (meeting) => meeting.id === "meeting",
  )!.messages;
  assert.deepEqual(
    messages.map((message) => message.id),
    ["source", "result", "live"],
  );
  assert.equal(messages[0].authorName, "member");
  assert.equal(messages[0].replyText, "Direct answer");
  assert.equal(messages[1].role, "assistant");
  assert.equal(messages[1].text, "Verified task result");
  assert.equal(messages[1].authorName, "IDO");
  assert.equal(messages[2].authorName, "IDO (Live)");
  assert.deepEqual(
    state.meetings
      .find((meeting) => meeting.id === "other")!
      .messages.map((message) => message.id),
    ["other-result"],
  );
  assert.deepEqual(store.list("message"), beforeMessages);
  assert.deepEqual(store.list("conversation-output"), beforeOutputs);
  await assert.rejects(
    workspace.request("state", {}, { ...context, valid: () => false }),
    /LOGIN_REQUIRED/,
  );
});

test("an older answer remains visible when a source message later points to a different reply", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-output-history-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const user = store.createUser("member", "test-password-long", "member");
  store.put("meeting", "meeting", {
    id: "meeting",
    name: "Meeting",
    summary: "",
    messages: [
      {
        id: "source",
        authorId: user.id,
        text: "Question",
        replyText: "Latest answer",
        at: 1,
        stage: "completed",
      },
    ],
  });
  store.put("conversation-output", "older", {
    id: "older",
    meetingId: "meeting",
    text: "Earlier answer",
    sourceIds: ["source"],
    at: 2,
  });
  store.put("conversation-output", "latest", {
    id: "latest",
    meetingId: "meeting",
    text: "Latest answer",
    sourceIds: ["source"],
    at: 3,
  });
  const workspace = new Workspace(
    store,
    new Tasks(store),
    {} as any,
    () => {},
    async () => undefined,
    () => "",
  );
  const context: InputContext = {
    pluginId: "dashboard",
    actor: user,
    valid: () => true,
    deliver: async () => {},
    publish() {},
  };
  const state = (await workspace.request(
    "state",
    {},
    context,
  )) as WorkspaceState;
  assert.deepEqual(
    state.meetings[0].messages.map((message) => message.id),
    ["source", "older"],
  );
});
