import test from "node:test";
import assert from "node:assert/strict";
import {
  createIdobataMessageHandler,
  createIdobataInteractionHandler,
  createIdobataSlashHandler,
} from "../src/adapters/discord/commands.mjs";
import { CodexAgentTeam } from "../src/discord-agent-team.mjs";
import { TaskQueue } from "../src/engine/task-queue.mjs";
import { AgentWorkerGateway } from "../src/discord-agent-worker-gateway.mjs";
import { AgentWorkerRegistry } from "../src/discord-agent-worker-registry.mjs";
import { DiscordAgentWorker } from "../src/discord-agent-worker.mjs";
import { canControlDiscordTask } from "../src/discord-task-access.mjs";
import { createDiscordTaskThread } from "../src/adapters/discord/transport.mjs";

const owners = ["123456789012345678", "123456789012345679"];
const config = {
  guildId: "guild",
  textChannelId: "commands",
  workerAllowGuildMembers: true,
  allowedUserId: "123456789012345680",
};
const until = async (predicate) => {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Timed out");
};

test("two participants create Forum Issues on their own Workers and stop them from Discord", async (t) => {
  const team = new CodexAgentTeam([
    {
      id: "host",
      enabled: true,
      online: true,
      transport: "local",
      maximumConcurrentTasks: 2,
      capabilities: [],
    },
  ]);
  const gateway = new AgentWorkerGateway({
    registry: new AgentWorkerRegistry(),
    agentTeam: team,
    port: 0,
    authorizeOwner: async (id) => owners.includes(id),
    logger: { warn() {} },
  });
  await gateway.start();
  t.after(() => gateway.stop());
  const started = new Map();
  const cancelled = new Set();
  for (const ownerUserId of owners) {
    const pairing = await gateway.createPairing({ ownerUserId });
    const worker = new DiscordAgentWorker({
      gatewayUrl: `ws://127.0.0.1:${gateway.address().port}`,
      pairingCode: pairing.code,
      executor: {
        run: async (task, { signal }) =>
          new Promise((resolve, reject) => {
            started.set(ownerUserId, task.id);
            signal.addEventListener(
              "abort",
              () => {
                cancelled.add(ownerUserId);
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      },
    });
    await worker.connect();
    t.after(() => worker.stop());
  }
  const forums = [];
  const makeThread = createDiscordTaskThread(
    { send: async () => {} },
    {
      issueForum: {
        threads: {
          create: async (options) => {
            const id = `forum-${forums.length}`;
            forums.push(options);
            const starter = { edit: async () => starter };
            return {
              id,
              fetchStarterMessage: async () => starter,
              send: async () => ({ id: "post" }),
            };
          },
        },
      },
    },
  );
  const queue = new TaskQueue({
    agentTeam: team,
    concurrency: 2,
    logger: {},
    postText: async () => {},
    createTaskThread: makeThread,
    runTask: (task, options) => gateway.runTask(task, options),
  });
  t.after(() => queue.stop());
  const replies = [];
  const handler = createIdobataMessageHandler({
    config,
    workerGateway: gateway,
    taskQueue: queue,
    session: { minutes: "", results: [] },
  });
  let sequence = 0;
  const message = (owner, content, channelId = "commands") => ({
    id: String(++sequence),
    guildId: "guild",
    channelId,
    author: { id: owner },
    content,
    channel: { send: async (p) => replies.push(p) },
  });
  for (const owner of owners)
    await handler(message(owner, "/ido task connection test"));
  await until(() => started.size === 2);
  assert.equal(forums.length, 2);
  const snapshots = queue.snapshot();
  for (const owner of owners) {
    const task = snapshots.find((x) => x.requestedByUserId === owner);
    assert.equal(task.workerOwnerUserId, owner);
    assert.equal(task.assignedAgentOwnerUserId, owner);
    assert.equal(task.id, started.get(owner));
  }
  const a = started.get(owners[0]);
  const b = started.get(owners[1]);
  await handler(message(owners[1], `/ido stop ${a}`));
  assert.equal(queue.tasks.get(a).cancelled, false);
  await handler(message(owners[0], `/ido stop ${a}`));
  await until(() => cancelled.has(owners[0]));
  assert.equal(cancelled.has(owners[1]), false);
  const buttons = createIdobataInteractionHandler({
    config,
    taskQueue: queue,
    workerGateway: gateway,
  });
  const interaction = (owner) => ({
    id: String(++sequence),
    guildId: "guild",
    customId: `ido:stop:${b}`,
    user: { id: owner },
    deferReply: async () => {},
    reply: async (p) => replies.push(p),
    editReply: async (p) => replies.push(p),
  });
  await buttons(interaction(owners[0]));
  assert.equal(cancelled.has(owners[1]), false);
  await buttons(interaction(owners[1]));
  await until(() => cancelled.has(owners[1]));
  assert.equal(queue.tasks.get(b).state, "cancelled");
  started.delete(owners[0]);
  cancelled.delete(owners[0]);
  await handler(message(owners[0], "/ido task forum stop test"));
  await until(() => started.has(owners[0]));
  const next = queue.tasks.get(started.get(owners[0]));
  await handler(message(owners[1], "停止", next.surface.threadId));
  assert.equal(next.cancelled, false);
  await handler(message(owners[0], "停止", next.surface.threadId));
  await until(() => cancelled.has(owners[0]));
  await handler(message(owners[0], "/ido leave"));
  assert.match(replies.at(-1).content, /Bot全体/);
});

test("owned assignments survive restore and never fall back to the host or another owner", async (t) => {
  const agent = (id, owner, online = true) => ({
    id,
    ownerUserId: owner,
    online,
    enabled: true,
    transport: owner ? "remote" : "local",
    capabilities: [],
    maximumConcurrentTasks: 1,
  });
  const team = new CodexAgentTeam([
    agent("host"),
    agent("a", owners[0], false),
    agent("b", owners[1]),
  ]);
  const task = {
    id: "owned",
    title: "test",
    state: "queued",
    requestedByUserId: owners[0],
    workerOwnerUserId: owners[0],
    assignedAgentId: "a",
    instructions: [],
  };
  team.reassign(task, [], ["a"]);
  assert.equal(task.assignedAgentId, "a");
  assert.equal(team.canRun(task), false);
  const q = new TaskQueue({
    agentTeam: team,
    runTask: () => assert.fail("offline owner must not run"),
    createTaskThread: async () => ({
      post: async () => {},
      update: async () => {},
    }),
    postText: async () => {},
    logger: {},
  });
  t.after(() => q.stop());
  await q.restore([task]);
  assert.equal(q.snapshot()[0].workerOwnerUserId, owners[0]);
  assert.equal(q.snapshot()[0].requestedByUserId, owners[0]);
  assert.equal(q.tasks.get("owned").assignedAgentId, "a");
  assert.equal(
    await canControlDiscordTask(config, {}, owners[0], task, "stop"),
    true,
  );
  assert.equal(
    await canControlDiscordTask(config, {}, owners[1], task, "stop"),
    false,
  );
  assert.equal(
    await canControlDiscordTask(
      config,
      { authorizeOwner: async () => false },
      owners[0],
      task,
      "follow",
    ),
    false,
  );
  assert.equal(
    await canControlDiscordTask(config, {}, config.allowedUserId, task, "stop"),
    true,
  );
});

test("enrollment policy and registration are checked for task creation; setup stays private", async () => {
  const replies = [];
  let accepted = 0;
  let allowed = false;
  const handler = createIdobataMessageHandler({
    config,
    session: {},
    taskQueue: {
      enqueueDurable: async () => {
        accepted++;
        return true;
      },
    },
    workerGateway: {
      authorizeOwner: async () => allowed,
      statusForOwner: () => [],
    },
    buildDownload: async () => ({
      name: "Connect-Agent.cmd",
      attachment: Buffer.from("test"),
    }),
  });
  const message = {
    guildId: "guild",
    channelId: "commands",
    author: { id: owners[0] },
    content: "/ido task test",
    channel: { send: async (p) => replies.push(p) },
  };
  await handler(message);
  allowed = true;
  await handler(message);
  assert.equal(accepted, 0);
  const slash = createIdobataSlashHandler({ config, handleMessage: handler });
  await slash({
    isButton: () => true,
    customId: "ido:agent-setup",
    guildId: "guild",
    channelId: "commands",
    user: { id: owners[0] },
    deferReply: async (p) => assert.equal(p.flags, 64),
    editReply: async (p) => replies.push(p),
  });
  assert.equal(replies.at(-1).files[0].name, "Connect-Agent.cmd");
  assert.deepEqual(replies.at(-1).allowedMentions, { parse: [] });
});
