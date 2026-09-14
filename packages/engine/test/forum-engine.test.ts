import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/adapters/sqlite/store.js";
import { PluginBroker } from "../src/adapters/plugins/broker.js";
import { InputRouter } from "../src/processing/routing/input.js";
import { Conversation } from "../src/processing/conversation.js";
import { OpenAIModels } from "../src/adapters/openai/models.js";
import { Credentials } from "@ido/common/runtime/credentials";
import { Tasks } from "../src/processing/tasks/service.js";
import type { Task } from "@ido/common/contracts/protocol";
import {
  ForumSync,
  forumKey,
  type ForumRecord,
} from "../../plugin-discord/src/forum/sync.js";
import { normalizeInput } from "../../plugin-discord/src/input/normalize.js";

test("Engine tasks synchronize to a forum, controls return to the same task and viewer cannot stop it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-forum-engine-"));
  const store = new Store(directory);
  const conversation = new Conversation(
    store,
    new OpenAIModels(new Credentials(directory, "test", "file")),
  );
  const router = new InputRouter(store, conversation, () => {});
  t.after(async () => {
    await router.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const config = {
    guildId: "1",
    issueForumChannelId: "123456789012345678",
    textChannelId: "2",
    meetingId: "meeting",
    projectId: "project",
  };
  store.put("config", "discord", config);
  store.put("meeting", "meeting", {
    id: "meeting",
    name: "Meeting",
    summary: "",
    messages: [],
  });
  store.put("project", "project", { id: "project", name: "Project" });
  for (const [subject, role] of [
    ["100", "member"],
    ["200", "viewer"],
  ]) {
    store.put("participant", `actor-${subject}`, {
      id: `actor-${subject}`,
      name: `Member ${subject}`,
      role,
    });
    store.put("external-participant", `discord:${subject}`, {
      actorId: `actor-${subject}`,
    });
  }
  const outputs: any[] = [];
  const plugin = {
    generation: 1,
    revision: 1,
    manifest: { capabilities: ["text", "task-forum", "project-conversation"] },
    request: async (_op: string, data: any) => outputs.push(data.output),
  };
  const broker = new PluginBroker(
    store,
    () => ({ get: () => plugin, publish: () => {} }) as any,
    router,
    {} as any,
    () => "https://engine.example.com",
  );
  const task = new Tasks(store).createTask({
    projectId: "project",
    meetingId: "meeting",
    authorId: "actor-100",
    text: "Implement page",
    requestId: "request",
    network: false,
  });
  store.put("task", "other", {
    ...task,
    id: "other",
    projectId: "other-project",
  });
  let records: ForumRecord[] | undefined;
  const cards: string[] = [];
  const forum = new ForumSync(
    config,
    {
      find: async () => "thread",
      create: async (_title, content) => {
        cards.push(content);
        return content.startsWith(`IDO task ${task.id}\n`)
          ? "thread"
          : "discussion-thread";
      },
      update: async (_id, content) => {
        cards.push(content);
      },
    },
    async () => records,
    async (value) => {
      records = structuredClone(value);
      store.put("plugin:discord", forumKey(config), records);
    },
  );
  const snapshot = async () =>
    (await broker.request("discord", "tasks.snapshot", {})) as Task[];
  assert.equal((await snapshot()).length, 2);
  await forum.sync(await snapshot());
  const send = async (
    userId: string,
    command: "stop" | "steer" | "context",
    eventId: string,
    text: string,
  ) => {
    const input = normalizeInput(
      {
        guildId: "1",
        channelId: "thread",
        userId,
        command,
        eventId,
        taskId: task.id,
        text,
      },
      config,
      undefined,
      undefined,
      forum.taskForThread("thread"),
    )!;
    await broker.request(
      "discord",
      "input",
      input as unknown as Record<string, unknown>,
    );
  };
  await send("100", "context", "conversation", "What should we test?");
  assert.equal(
    store.get<Task>("task", task.id)?.specRevision,
    task.specRevision,
  );
  assert.equal(store.list<Task>("task").length, 2);
  // Switching the default project must not detach this persisted issue thread.
  store.put("project", "new-project", { id: "new-project", name: "New" });
  store.put("config", "discord", { ...config, projectId: "new-project" });
  await send("100", "steer", "instruction", "指示: Add tests");
  assert.equal(store.list<Task>("task").length, 2);
  assert.ok(
    (store.get<Task>("task", task.id)?.specRevision ?? 0) >
      (task.specRevision ?? 0),
  );
  assert.equal(outputs.at(-1).replyTo.channelId, "thread");
  await assert.rejects(
    send("200", "stop", "denied", "stop"),
    /PERMISSION_DENIED/,
  );
  assert.equal(store.get<Task>("task", task.id)?.state, "queued");

  await send("100", "stop", "stop", "stop");
  assert.equal(store.get<Task>("task", task.id)?.state, "cancelled");
  await forum.sync(await snapshot());
  assert.ok(cards.some((card) => card.includes("cancelled")));
  plugin.manifest.capabilities = ["text"];
  await assert.rejects(
    broker.request("discord", "tasks.snapshot", {}),
    /PERMISSION_DENIED/,
  );
});
