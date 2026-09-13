import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { voiceErrorMessage } from "../src/engine/errors.mjs";
import { AgentWorkerRegistry } from "../src/discord-agent-worker-registry.mjs";
import {
  AgentWorkerGateway,
  validateWorkerGatewayConfig,
} from "../src/discord-agent-worker-gateway.mjs";
import {
  DiscordAgentWorker,
  LocalCodexWorkerExecutor,
} from "../src/discord-agent-worker.mjs";
import { CodexAgentTeam } from "../src/discord-agent-team.mjs";
import { createDistributedTaskRunner } from "../src/discord-agent-task-runner.mjs";
import { TaskQueue as DiscordVoiceTaskQueue } from "../src/engine/task-queue.mjs";
import {
  createIdobataMessageHandler,
  createIdobataSlashHandler,
  IDOBATA_APPLICATION_COMMAND,
} from "../src/adapters/discord/commands.mjs";
import {
  DiscordAgentWebhookPublisher,
  generateAgentAvatar,
} from "../src/discord-agent-avatar.mjs";
import {
  readAgentWorkerCredential,
  writeAgentWorkerCredential,
} from "../src/discord-agent-worker-credentials.mjs";

const owner = "123456789012345678";
const exec = promisify(execFile);
const eventually = async (check) => {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};

function signedPair(registry, now = Date.now()) {
  const pairing = registry.createPairing({
    ownerUserId: owner,
    ownerDisplayName: "Alice",
    ownerAvatarUrl: "https://cdn.discordapp.com/avatars/123/hash.png",
  });
  const keys = generateKeyPairSync("ed25519");
  const challenge = "challenge";
  return {
    pairing,
    keys,
    challenge,
    complete: () =>
      registry.completePairing({
        code: pairing.code,
        challenge,
        publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
        signature: sign(null, Buffer.from(challenge), keys.privateKey).toString(
          "base64url",
        ),
        capabilities: ["frontend", "test", "*", "INVALID CAPABILITY"],
        maximumConcurrentTasks: 2,
        name: "Alice Codex",
        now,
      }),
  };
}

test("pairing stores only a token hash and verifies the device key", () => {
  const registry = new AgentWorkerRegistry();
  const { complete, keys, challenge } = signedPair(registry);
  const paired = complete();
  assert.equal(paired.agentId, `member-${owner}`);
  assert.deepEqual(paired.worker.capabilities, ["frontend", "test", "*"]);
  const persisted = registry.snapshot()[0];
  assert.equal("token" in persisted, false);
  assert.notEqual(persisted.tokenHash, paired.token);
  assert.equal(
    registry.authenticate({
      agentId: paired.agentId,
      token: paired.token,
      challenge,
      signature: sign(null, Buffer.from(challenge), keys.privateKey).toString(
        "base64url",
      ),
    }),
    true,
  );
  assert.equal(
    registry.authenticate({
      agentId: paired.agentId,
      token: "wrong",
      challenge,
      signature: "wrong",
    }),
    false,
  );
});

test("expired pairing codes fail closed", () => {
  let now = 1_000;
  const registry = new AgentWorkerRegistry({
    now: () => now,
    pairingTtlMs: 100,
  });
  const pairing = signedPair(registry);
  now = 1_101;
  assert.throws(pairing.complete, /expired/);
});

test("a paired Worker receives a task and returns progress and result", async () => {
  const registry = new AgentWorkerRegistry();
  const team = new CodexAgentTeam([
    {
      id: "default",
      name: "Host Codex",
      capabilities: ["*"],
      maximumConcurrentTasks: 1,
      workingDirectory: process.cwd(),
      enabled: true,
    },
  ]);
  const gateway = new AgentWorkerGateway({
    registry,
    agentTeam: team,
    host: "127.0.0.1",
    port: 0,
    publicUrl: "ws://127.0.0.1:0",
    defaultWorkingDirectory: process.cwd(),
    heartbeatTimeoutMs: 5_000,
    leaseTtlMs: 5_000,
  });
  await gateway.start();
  const url = `ws://127.0.0.1:${gateway.address().port}`;
  const pairing = await gateway.createPairing({
    ownerUserId: owner,
    ownerDisplayName: "Alice",
    ownerAvatarUrl: "https://cdn.discordapp.com/avatars/123/hash.png",
  });
  let stored;
  const worker = new DiscordAgentWorker({
    gatewayUrl: url,
    pairingCode: pairing.code,
    name: "Alice Codex",
    capabilities: ["frontend"],
    maximumConcurrentTasks: 1,
    credentialWriter: async (value) => {
      stored = value;
    },
    executor: {
      run: async (task, { onProgress }) => {
        await onProgress("working");
        return {
          result: `done:${task.issueId}`,
          codexThreadId: "thread-1",
          runRevision: 1,
          evidence: { commands: 1, privateValue: "secret" },
          artifacts: {
            hasChanges: false,
            workingDirectory: "C:\\private\\worktree",
            patchPath: "C:\\private\\result.patch",
          },
        };
      },
    },
    heartbeatIntervalMs: 100,
  });
  await worker.connect();
  assert.equal(stored.agentId, `member-${owner}`);
  assert.equal(gateway.isOnline(stored.agentId), true);
  assert.equal(team.get(stored.agentId).transport, "remote");
  const progress = [];
  const task = {
    id: "task-1",
    issueId: "issue-1",
    title: "UI",
    request: "frontend",
    assignedAgentId: stored.agentId,
  };
  const result = await gateway.runTask(task, {
    onProgress: async (value) => progress.push(value),
  });
  assert.equal(result, "done:issue-1");
  assert.deepEqual(progress, ["working"]);
  assert.equal(task.remoteExecution, true);
  assert.equal(task.codexThreadId, "thread-1");
  assert.equal("privateValue" in task.evidence, false);
  assert.equal("workingDirectory" in task.artifacts, false);
  assert.equal("patchPath" in task.artifacts, false);
  worker.executor.run = async () => {
    const error = new Error("private local details");
    error.code = "AGENT_SANDBOX_NOT_READY";
    throw error;
  };
  await assert.rejects(
    gateway.runTask({ ...task, id: "failed-sandbox" }),
    (error) => {
      assert.equal(error.code, "AGENT_SANDBOX_NOT_READY");
      assert.match(voiceErrorMessage(error), /Windowsサンドボックス/);
      assert.doesNotMatch(voiceErrorMessage(error), /private local details/);
      return true;
    },
  );
  await worker.stop();
  await gateway.stop();
});

test("agent avatars are generated locally and Webhook posts target the Forum thread", async () => {
  const source = await sharp({
    create: { width: 64, height: 64, channels: 4, background: "#335577" },
  })
    .png()
    .toBuffer();
  const profile = {
    id: "frontend",
    name: "Frontend Codex",
    ownerDisplayName: "Alice",
    ownerAvatarUrl: "https://cdn.discordapp.com/avatars/123/hash.png",
  };
  const avatar = await generateAgentAvatar(profile, {
    fetchImpl: async () => ({
      ok: true,
      arrayBuffer: async () => source,
    }),
  });
  const metadata = await sharp(avatar).metadata();
  assert.equal(metadata.width, 256);
  assert.equal(metadata.height, 256);

  const sent = [];
  const webhook = {
    name: "ido-agent-frontend",
    send: async (payload) => sent.push(payload),
    edit: async () => undefined,
  };
  const publisher = new DiscordAgentWebhookPublisher({
    issueForum: {
      fetchWebhooks: async () => new Map(),
      createWebhook: async ({ avatar: createdAvatar }) => {
        assert.ok(Buffer.isBuffer(createdAvatar));
        return webhook;
      },
    },
    agentTeam: { get: () => profile },
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => source }),
  });
  await publisher.post("frontend", { id: "forum-thread" }, "hello");
  assert.equal(sent[0].threadId, "forum-thread");
  assert.equal(sent[0].username, "Frontend Codex · Alice");
  assert.match(sent[0].content, /Agent: frontend/);
  assert.match(sent[0].content, /hello/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
});

test("the private Discord slash reply retains pairing and guide buttons without a user token", async () => {
  const group = IDOBATA_APPLICATION_COMMAND.options.find(
    (option) => option.name === "agent",
  );
  assert.equal(group.type, 2);
  assert.deepEqual(
    group.options.map(({ name }) => name),
    ["setup", "connect", "disconnect", "status"],
  );
  const replies = [];
  const calls = [];
  const config = {
    guildId: "222222222222222222",
    textChannelId: "333333333333333333",
    agentCoordinationChannelId: "333333333333333333",
    codexAgents: [],
    allParticipantsOperate: true,
    silentMessages: true,
    agentJoinGuideUrl: "https://example.com/agent-guide",
  };
  const handler = createIdobataMessageHandler({
    config,
    session: {},
    taskQueue: undefined,
    workerGateway: {
      createPairing: (identity) => {
        calls.push(identity);
        return {
          code: "PAIR-CODE",
          expiresAt: Date.now() + 300_000,
          gatewayUrl: "wss://agents.example.test",
        };
      },
    },
  });
  const slash = createIdobataSlashHandler({ config, handleMessage: handler });
  await slash({
    id: "interaction-1",
    guildId: "222222222222222222",
    channelId: "333333333333333333",
    isChatInputCommand: () => true,
    commandName: "ido",
    options: {
      getString: () => null,
      getSubcommandGroup: () => "agent",
      getSubcommand: () => "connect",
    },
    user: { id: owner, username: "alice", bot: false },
    member: { displayName: "Alice" },
    deferReply: async (payload) => assert.equal(payload.flags, 64),
    editReply: async (payload) => replies.push(payload),
    followUp: async () => assert.fail("Expected a single private reply"),
  });
  assert.equal(calls[0].ownerUserId, owner);
  const invitation = replies[0].content.match(
    /```text\n(ido1\.[A-Za-z0-9_-]+)\n```/,
  )[1];
  assert.equal(
    JSON.parse(Buffer.from(invitation.slice(5), "base64url").toString("utf8"))
      .code,
    "PAIR-CODE",
  );
  assert.doesNotMatch(replies[0].content, /token|auth\.json/i);
  assert.equal(
    replies[0].components[0].components[0].custom_id,
    "ido:agent-setup",
  );
  assert.deepEqual(replies[0].allowedMentions, { parse: [] });
  assert.equal(
    replies[0].components[0].components[1].url,
    config.agentJoinGuideUrl,
  );
});

test("slash follow-ups retain components and remain private with mentions disabled", async () => {
  const config = { guildId: "guild", textChannelId: "channel" };
  const button = {
    type: 1,
    components: [
      { type: 2, style: 5, label: "Guide", url: "https://example.com/guide" },
    ],
  };
  const replies = [];
  const slash = createIdobataSlashHandler({
    config,
    handleMessage: async (message) => {
      await message.channel.send({ content: "First", components: [button] });
      await message.channel.send({
        content: "Second",
        components: [button],
        allowedMentions: { parse: ["everyone"] },
      });
    },
  });
  await slash({
    isChatInputCommand: () => true,
    commandName: "ido",
    guildId: "guild",
    channelId: "channel",
    options: { getString: () => null, getSubcommand: () => "help" },
    user: { id: owner },
    deferReply: async (payload) => assert.equal(payload.flags, 64),
    editReply: async (payload) => replies.push(payload),
    followUp: async (payload) => replies.push(payload),
  });
  assert.equal(replies.length, 2);
  for (const reply of replies) {
    assert.deepEqual(reply.components, [button]);
    assert.deepEqual(reply.allowedMentions, { parse: [] });
  }
  assert.equal(replies[1].flags, 64);
});

test("the Worker gateway requires TLS away from loopback", () => {
  assert.throws(
    () =>
      validateWorkerGatewayConfig({
        host: "0.0.0.0",
        publicUrl: "ws://agents.example.test",
      }),
    /loopback/,
  );
  assert.throws(
    () =>
      validateWorkerGatewayConfig({
        host: "0.0.0.0",
        publicUrl: "wss://agents.example.test",
      }),
    /loopback/,
  );
  assert.doesNotThrow(() =>
    validateWorkerGatewayConfig({
      host: "127.0.0.1",
      publicUrl: "ws://127.0.0.1:8787",
    }),
  );
  assert.doesNotThrow(() =>
    validateWorkerGatewayConfig({
      host: "127.0.0.1",
      publicUrl: "wss://agents.example.test",
    }),
  );
});

test("an expired remote lease is reassigned without reusing its credential", async () => {
  const team = new CodexAgentTeam([
    {
      id: "host",
      name: "Host Codex",
      capabilities: ["*"],
      maximumConcurrentTasks: 1,
      workingDirectory: process.cwd(),
      transport: "local",
      online: true,
      enabled: true,
    },
    {
      id: "member-123456789012345678",
      name: "Alice Codex",
      capabilities: ["frontend"],
      maximumConcurrentTasks: 1,
      workingDirectory: process.cwd(),
      transport: "remote",
      online: true,
      enabled: true,
    },
  ]);
  const task = {
    id: "lease-task",
    title: "frontend",
    request: "frontend",
    assignedAgentId: "member-123456789012345678",
    assignedAgentName: "Alice Codex",
  };
  task.agentExecutionLease = { assignedAgentId: task.assignedAgentId };
  team.start(task.agentExecutionLease);
  team.setOnline(task.assignedAgentId, false);
  let checkpoints = 0;
  task.checkpoint = async () => checkpoints++;
  const progress = [];
  const error = new Error("expired");
  error.code = "WORKER_LEASE_EXPIRED";
  const run = createDistributedTaskRunner({
    localRunner: async () => "host result",
    workerGateway: {
      hasAgent: (id) => id.startsWith("member-"),
      runTask: async () => {
        throw error;
      },
    },
    agentTeam: team,
  });
  const result = await run(task, {
    onProgress: async (message) => progress.push(message),
  });
  assert.equal(result, "host result");
  assert.equal(task.assignedAgentId, "host");
  assert.equal(task.reassignments[0].reason, "WORKER_LEASE_EXPIRED");
  assert.equal(checkpoints, 1);
  assert.match(progress[0], /再割り当て/);
  team.finish(task.agentExecutionLease);
});

test("a local Codex Worker keeps changes in an isolated worktree and returns only public metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "ido-agent-worker-"));
  const repository = join(root, "repository");
  const workspaces = join(root, "workspaces");
  await exec("git", ["init", repository]);
  await exec("git", [
    "-C",
    repository,
    "config",
    "user.email",
    "test@example.invalid",
  ]);
  await exec("git", ["-C", repository, "config", "user.name", "Test"]);
  await writeFile(join(repository, "README.md"), "source\n");
  await exec("git", ["-C", repository, "add", "README.md"]);
  await exec("git", ["-C", repository, "commit", "-m", "initial"]);

  let workerDirectory;
  let resumedThread;
  const executor = new LocalCodexWorkerExecutor({
    workingDirectory: repository,
    workspaceDirectory: workspaces,
    codex: {
      startThread: (options) => {
        assert.equal(options.sandboxMode, "workspace-write");
        assert.equal(options.networkAccessEnabled, false);
        assert.equal(options.webSearchMode, "disabled");
        workerDirectory = options.workingDirectory;
        return {
          id: "local-thread",
          run: async () => {
            await writeFile(
              join(workerDirectory, "worker-result.txt"),
              "done\n",
            );
            return { finalResponse: "completed" };
          },
        };
      },
      resumeThread: (threadId) => {
        resumedThread = threadId;
        return {
          id: threadId,
          run: async () => {
            await writeFile(
              join(workerDirectory, "worker-result.txt"),
              "continued\n",
            );
            return { finalResponse: "continued" };
          },
        };
      },
    },
  });

  try {
    const task = {
      id: "task-isolated",
      issueId: "issue-42",
      title: "isolated task",
      request: "create a result",
      agentId: "member-123",
      agentName: "Alice Codex",
      codexThreadId: "central-thread",
    };
    const result = await executor.run(task);
    assert.notEqual(workerDirectory, repository);
    assert.equal(
      await readFile(join(repository, "README.md"), "utf8"),
      "source\n",
    );
    await assert.rejects(readFile(join(repository, "worker-result.txt")), {
      code: "ENOENT",
    });
    assert.equal(result.result, "completed");
    assert.equal(result.codexThreadId, "local-thread");
    assert.equal(resumedThread, undefined);
    assert.doesNotMatch(
      await readFile(
        join(workspaces, "task-isolated-agent-state.json"),
        "utf8",
      ),
      /central-thread/,
    );
    assert.equal(result.artifacts.hasChanges, true);
    assert.match(result.artifacts.status, /worker-result\.txt/);
    assert.equal("workingDirectory" in result.artifacts, false);
    assert.equal("patchPath" in result.artifacts, false);
    const continued = await executor.run(task);
    assert.equal(resumedThread, "local-thread");
    assert.equal(continued.result, "continued");
    assert.equal(continued.runRevision, 2);
  } finally {
    if (workerDirectory) {
      await exec("git", [
        "-C",
        repository,
        "worktree",
        "remove",
        "--force",
        workerDirectory,
      ]).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
  }
});

test(
  "Windows stores the Worker token and private key as a CurrentUser DPAPI blob",
  { skip: process.platform !== "win32" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ido-agent-credential-"));
    const previous = process.env.PERSONAL_CONTEXT_AGENT_CREDENTIAL_DIR;
    process.env.PERSONAL_CONTEXT_AGENT_CREDENTIAL_DIR = root;
    const credential = {
      agentId: `member-${owner}`,
      token: "local-worker-secret-token",
      publicKey: "public-key",
      privateKey: "local-private-key",
      gatewayUrl: "wss://agents.example.test",
    };
    try {
      await writeAgentWorkerCredential(credential);
      const encrypted = await readFile(join(root, "agent-worker.dpapi"));
      assert.doesNotMatch(
        encrypted.toString("utf8"),
        /local-worker-secret-token|local-private-key/,
      );
      assert.deepEqual(await readAgentWorkerCredential(), credential);
    } finally {
      if (previous === undefined)
        delete process.env.PERSONAL_CONTEXT_AGENT_CREDENTIAL_DIR;
      else process.env.PERSONAL_CONTEXT_AGENT_CREDENTIAL_DIR = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("remote results expose review metadata without local paths or an apply action", async (t) => {
  const posts = [];
  let artifactPosts = 0;
  const queue = new DiscordVoiceTaskQueue({
    logger: {},
    postText: async () => undefined,
    createTaskThread: async () => ({
      post: async (content) => posts.push(content),
      postArtifacts: async () => artifactPosts++,
      update: async () => undefined,
    }),
    runTask: async (task) => {
      task.runRevision = 1;
      task.remoteExecution = true;
      task.evidence = { runRevision: 1, commands: 1, tests: [] };
      task.artifacts = {
        remote: true,
        hasChanges: true,
        status: "A worker-result.txt",
        patchHash: "a".repeat(64),
        runRevision: 1,
        note: "kept on the participant device",
      };
      return "remote result";
    },
    applyTask: async () => {
      throw new Error("Remote work must never be applied by the central Bot.");
    },
  });
  t.after(() => queue.stop());
  await queue.enqueueDurable({ id: "remote-result", title: "remote task" });
  await eventually(
    () =>
      queue.active === 0 &&
      queue.snapshot()[0]?.resultDeliveryPending === false,
  );
  assert.equal(artifactPosts, 0);
  assert.match(posts.join("\n"), /担当者端末の確認用成果/);
  assert.doesNotMatch(posts.join("\n"), /undefined|private\\|result\.patch/);
  assert.equal(await queue.applyTask("remote-result", 1), false);
});
