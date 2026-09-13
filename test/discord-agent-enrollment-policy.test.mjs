import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  canEnrollWorker,
  createWorkerOwnerAuthorizer,
} from "../src/discord-agent-enrollment-policy.mjs";
import { AgentWorkerRegistry } from "../src/discord-agent-worker-registry.mjs";
import { AgentWorkerGateway } from "../src/discord-agent-worker-gateway.mjs";
import { DiscordAgentWorker } from "../src/discord-agent-worker.mjs";
import { createIdobataMessageHandler } from "../src/adapters/discord/commands.mjs";

const owner = "123456789012345678";
const guildId = "223456789012345678";
const roleId = "323456789012345678";
const config = {
  guildId,
  workerAllowGuildMembers: true,
  allParticipantsOperate: false,
};
const member = {
  userId: owner,
  guildId,
  roleIds: [roleId],
  bot: false,
  pending: false,
};

test("guild membership and optional roles are independent of Bot management permission", () => {
  assert.equal(canEnrollWorker(config, owner, member), true);
  assert.equal(
    canEnrollWorker(
      { ...config, workerEnrollmentRoleIds: [roleId] },
      owner,
      member,
    ),
    true,
  );
  for (const changed of [
    undefined,
    { ...member, guildId: "other" },
    { ...member, userId: "other" },
    { ...member, bot: true },
    { ...member, pending: true },
  ])
    assert.equal(canEnrollWorker(config, owner, changed), false);
  assert.equal(
    canEnrollWorker({ ...config, workerEnrollmentRoleIds: [roleId] }, owner, {
      ...member,
      roleIds: [],
    }),
    false,
  );
  assert.equal(
    canEnrollWorker(
      { ...config, workerAllowGuildMembers: false },
      owner,
      member,
    ),
    false,
  );
  assert.equal(
    canEnrollWorker(
      { ...config, workerAllowGuildMembers: false, allowedUserId: owner },
      owner,
    ),
    true,
  );
});

test("member lookup is bounded, deduplicated and revalidated without stale authorization on failure", async () => {
  let now = 0;
  let calls = 0;
  let fail = false;
  const authorize = createWorkerOwnerAuthorizer({
    config,
    now: () => now,
    fetchMember: async () => {
      calls++;
      if (fail) throw new Error("lookup unavailable");
      return member;
    },
  });
  assert.deepEqual(await Promise.all([authorize(owner), authorize(owner)]), [
    true,
    true,
  ]);
  assert.equal(calls, 1);
  assert.equal(await authorize("invalid"), false);
  fail = true;
  now += 30_001;
  assert.equal(await authorize(owner), false);
  assert.equal(calls, 2);
  const timedOut = createWorkerOwnerAuthorizer({
    config,
    timeoutMs: 5,
    fetchMember: () => new Promise(() => {}),
  });
  assert.equal(await timedOut(owner), false);
});

test("role loss blocks redemption and later heartbeats using the same enrollment policy", async (t) => {
  let roles = [roleId];
  const registry = new AgentWorkerRegistry();
  const authorizeOwner = createWorkerOwnerAuthorizer({
    config: { ...config, workerEnrollmentRoleIds: [roleId] },
    cacheTtlMs: 0,
    fetchMember: async () => ({ ...member, roleIds: roles }),
  });
  const gateway = new AgentWorkerGateway({
    registry,
    port: 0,
    authorizeOwner,
    logger: { warn() {} },
  });
  await gateway.start();
  t.after(() => gateway.stop());
  const gatewayUrl = `ws://127.0.0.1:${gateway.address().port}`;
  const pairing = await gateway.createPairing({ ownerUserId: owner });
  roles = [];
  const rejected = new DiscordAgentWorker({
    gatewayUrl,
    pairingCode: pairing.code,
    executor: {},
  });
  t.after(() => rejected.stop());
  await assert.rejects(rejected.connect());
  assert.equal(registry.snapshot().length, 0);
  roles = [roleId];
  const fresh = await gateway.createPairing({ ownerUserId: owner });
  const worker = new DiscordAgentWorker({
    gatewayUrl,
    pairingCode: fresh.code,
    executor: {},
  });
  t.after(() => worker.stop());
  await worker.connect();
  roles = [];
  const closed = once(worker.socket, "close");
  worker.socket.send(JSON.stringify({ type: "heartbeat" }));
  assert.equal((await closed)[0], 4002);
  await assert.rejects(gateway.createPairing({ ownerUserId: owner }));
});

test("a guild participant can enroll their own Worker without receiving general task permission", async () => {
  const replies = [];
  let pairedOwner;
  const handler = createIdobataMessageHandler({
    config: { ...config, textChannelId: "channel", codexAgents: [] },
    session: {},
    workerGateway: {
      createPairing: async ({ ownerUserId }) => {
        pairedOwner = ownerUserId;
        return {
          code: "ABCDEFGHIJKL",
          gatewayUrl: "wss://example.com",
          expiresAt: Date.now() + 60_000,
        };
      },
    },
  });
  const message = {
    id: "interaction",
    guildId,
    channelId: "channel",
    privateReply: true,
    author: { id: owner },
    content: "/ido agent connect",
    channel: { send: async (payload) => replies.push(payload) },
  };
  await handler(message);
  assert.equal(pairedOwner, owner);
  assert.equal(replies[0].components[0].components.length, 1);
  await handler({
    ...message,
    id: "task-interaction",
    content: "/ido task do something",
  });
  assert.match(replies[1].content, /権限|操作担当/);
  pairedOwner = undefined;
  await handler({ ...message, guildId: "other" });
  assert.equal(pairedOwner, undefined);
});
