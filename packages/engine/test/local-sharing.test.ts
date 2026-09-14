import type { Run } from "../../client/src/execution/executor.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task, Command } from "@ido/common/contracts/protocol";
import { Store } from "../src/adapters/sqlite/store.js";
import { Tasks } from "../src/processing/tasks/service.js";
import { shareLocalTask } from "../src/processing/tasks/local-sharing.js";
import { Scheduler } from "../src/clients/scheduler.js";
import { Client } from "../../client/src/bootstrap/client.js";
import {
  receiveSharedLocalControl,
  sharedLocalSnapshot,
} from "../../client/src/connection/local-sharing.js";
import { ForumSync } from "../../plugin-discord/src/forum/sync.js";

test("local task sharing recovers lost responses, creates one forum thread and routes controls only to its owner", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-local-share-"));
  const store = new Store(join(directory, "engine"));
  const client = new Client(join(directory, "client"));
  t.after(async () => {
    await client.executor.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const project = { id: "project", name: "Fixture", remote: "" };
  store.put("project", project.id, project);
  for (const device of ["owner", "other"]) {
    store.put("device", device, {
      id: device,
      revoked: false,
      generation: 1,
      codexConnected: true,
      slots: 2,
      grants: [{ projectId: project.id, slots: 2, network: true }],
    });
    store.put("project-member", `${project.id}:${device}`, {
      projectId: project.id,
      deviceId: device,
    });
  }
  store.put("config", "discord", {
    projectId: project.id,
    issueForumChannelId: "forum",
  });
  client.settings.deviceId = "owner";
  client.settings.engineUrl = "https://team.example";
  client.settings.projects = [project];
  client.connected = true;
  client.generation = 1;
  client.localSharingSupported = true;
  await client.executor.load();
  const value: Run = (client.executor.runs.local = {
    origin: "local",
    state: "running",
    directory,
    progressMode: "manual",
    phase: "awaiting-plan",
    task: {
      id: "local",
      runId: "local",
      projectId: project.id,
      meetingId: "local",
      authorId: "local",
      requestId: "request",
      text: "Implement the feature",
      title: "Local fixture",
      network: true,
      revision: 1,
      specRevision: 1,
      state: "running",
      createdAt: 1,
      updatedAt: 1,
      history: [],
    },
    result: "PRIVATE_FILE_CONTENT",
    progress: "PRIVATE_COMMAND_OUTPUT",
    localMapping: { projectId: project.id, directory, network: true, slots: 1 },
    discordShare: {
      projectId: project.id,
      engineUrl: client.settings.engineUrl,
      deviceId: "owner",
      sequence: 0,
      status: "pending",
    },
  });
  let loseResponse = true;
  client.workspaceRequest = async <T>(
    _operation: string,
    input: Record<string, unknown>,
  ) => {
    const result = shareLocalTask(store, "owner", 1, input);
    if (loseResponse) {
      loseResponse = false;
      throw new Error("WORKSPACE_DELIVERY_UNKNOWN");
    }
    return result as T;
  };
  await client.syncLocalShares();
  assert.equal(value.discordShare?.status, "error");
  await client.syncLocalShares();
  assert.equal(value.discordShare?.status, "synced");
  assert.equal(store.list("task").length, 1);
  const mirrorId = value.discordShare!.taskId!;
  const mirror = store.get<Task>("task", mirrorId)!;
  assert.equal(mirror.clientId, "owner");
  assert.equal(mirror.progress, "実行の指示待ち");
  assert.ok(!JSON.stringify(mirror).includes("PRIVATE_"));
  assert.ok(!JSON.stringify(sharedLocalSnapshot(value)).includes(directory));
  new Scheduler(store).schedule(new Set(["owner", "other"]));
  assert.equal(store.pending("other").length, 0);
  assert.equal(store.pending("owner").length, 0);

  let creates = 0;
  const updates: string[] = [];
  let records: any[] = [];
  const forum = new ForumSync(
    { guildId: "guild", issueForumChannelId: "forum", projectId: project.id },
    {
      find: async () => "thread",
      create: async (_name, content) => {
        creates++;
        updates.push(content);
        return "thread";
      },
      update: async (_thread, content) => {
        updates.push(content);
      },
    },
    async () => records,
    async (value) => {
      records = structuredClone(value);
    },
  );
  await forum.sync([mirror]);
  await forum.sync([mirror]);
  assert.equal(creates, 1);
  assert.equal(forum.taskForThread("thread"), mirror.id);
  assert.match(updates[0], /Implement the feature/);
  assert.ok(!updates[0].includes("PRIVATE_"));

  const tasks = new Tasks(store);
  const receipt = tasks.control(
    mirror.id,
    "discord-user",
    "steer",
    "Please add coverage",
    { requestKey: "one" },
  );
  const command = { ...store.pending("owner")[0], generation: 1 } as Command;
  const frames: Command[] = [];
  client.emit = (data) => {
    frames.push(data);
  };
  // Avoid asynchronous sync in the command handler so assertions use explicit barriers.
  const sync = client.syncLocalShares;
  t.mock.method(client, "syncLocalShares", async () => {});
  assert.equal(
    await receiveSharedLocalControl(client, { ...command, generation: 2 }),
    false,
  );
  assert.equal(
    await receiveSharedLocalControl(client, { ...command, taskId: "wrong" }),
    false,
  );
  assert.equal(await receiveSharedLocalControl(client, command), true);
  assert.equal(await receiveSharedLocalControl(client, command), true);
  assert.equal(value.instructions?.length, 1);
  assert.equal(value.instructions?.[0].text, "Please add coverage");
  assert.equal(value.controlReceipts?.[receipt.id].delivery, "queued");
  assert.ok(
    frames.some((frame) => frame.type === "ack" && frame.id === command.id),
  );
  await sync();
  assert.equal(
    store.get<Task>("task", mirror.id)?.controlReceipts?.[receipt.id].delivery,
    "queued",
  );
  store.ack("owner", command.id!);
  tasks.control(mirror.id, "discord-user", "stop", undefined, {
    requestKey: "two",
  });
  assert.equal(
    await receiveSharedLocalControl(client, {
      ...store.pending("owner")[0],
      generation: 1,
    }),
    true,
  );
  assert.equal(value.state, "cancelled");
  await sync();
  await forum.sync(store.list<Task>("task"));
  assert.equal(creates, 1);
  assert.match(updates.at(-1)!, /cancelled/);
  assert.throws(
    () => tasks.control(mirror.id, "discord-user", "retry"),
    /LOCAL_RETRY_REQUIRED/,
  );
  const stale = {
    ...sharedLocalSnapshot(value),
    sequence: 1,
    state: "running",
  };
  shareLocalTask(store, "owner", 1, stale);
  assert.equal(store.get<Task>("task", mirror.id)?.state, "cancelled");
  store.remove("project-member", "project:owner");
  assert.throws(
    () => shareLocalTask(store, "owner", 1, { ...stale, sequence: 99 }),
    /PROJECT_INVITATION_REQUIRED/,
  );
  const before = value.discordShare!.sequence;
  client.settings.engineUrl = "https://different.example";
  await sync();
  assert.equal(value.discordShare!.sequence, before);
});
