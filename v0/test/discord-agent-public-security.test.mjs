import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import { AgentWorkerGateway } from "../src/discord-agent-worker-gateway.mjs";
import { AgentWorkerRegistry } from "../src/discord-agent-worker-registry.mjs";
import { DiscordAgentWorker } from "../src/discord-agent-worker.mjs";
import { AgentExecutionConsent } from "../src/discord-agent-execution-consent.mjs";
import {
  encodeAgentInvitation,
  decodeAgentInvitation,
  agentGuideComponents,
  agentInvitationUrl,
} from "../src/discord-agent-onboarding.mjs";
import { assertPublicWorkerPolicy } from "../src/discord-agent-public-policy.mjs";

test("execution waits for owner approval, rejects replay and respects cancellation", async () => {
  let calls = 0;
  const consent = new AgentExecutionConsent({
    executor: { run: async () => ++calls },
  });
  const task = {
    id: "task",
    title: "Review request",
    request: "Do work",
    automatic: true,
  };
  const running = consent.run(task);
  assert.equal(calls, 0);
  const [{ id }] = consent.describe();
  assert.equal(consent.decide("wrong-id", true), false);
  assert.equal(consent.decide(id, true), true);
  assert.equal(await running, 1);
  assert.equal(consent.decide(id, true), false);
  const controller = new AbortController();
  const aborted = assert.rejects(
    consent.run(task, { signal: controller.signal }),
    /did not approve/,
  );
  controller.abort();
  await aborted;
  assert.equal(consent.describe().length, 0);
  assert.equal(calls, 1);
});

test("Discord autofill links keep invitation data in the fragment and never include local permissions", () => {
  const pairing = {
    gatewayUrl: "wss://agents.example.com/workers",
    code: "ABCDEFGHIJKL",
    expiresAt: Date.now() + 60_000,
    workingDirectory: "/private/repo",
    automatic: true,
    networkAccess: true,
    token: "must-not-include",
  };
  const url = new URL(agentInvitationUrl(pairing));
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.search, "");
  assert.equal(url.pathname, "/join");
  assert.deepEqual(decodeAgentInvitation(url.hash.slice(1)), {
    gatewayUrl: pairing.gatewayUrl,
    pairingCode: pairing.code,
  });
  const encoded = Buffer.from(url.hash.slice(6), "base64url").toString();
  assert.doesNotMatch(encoded, /private|automatic|networkAccess|token/);
  const buttons = agentGuideComponents("https://example.com/join", pairing)[0]
    .components;
  assert.equal(buttons[0].custom_id, "ido:agent-setup");
  assert.equal(buttons[1].url, "https://example.com/join");
  assert.equal(new URL(buttons[1].url).hash, "");
  const longPairing = {
    ...pairing,
    gatewayUrl: `wss://example.com/${"a".repeat(500)}`,
  };
  assert.equal(
    agentGuideComponents(undefined, longPairing)[0].components[0].custom_id,
    "ido:agent-setup",
  );
  assert.equal(
    agentGuideComponents("https://example.com/join", longPairing)[0].components
      .length,
    2,
  );
});

test("approval expires without executing, while explicit session automation executes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  const executor = { run: async () => ++calls };
  const consent = new AgentExecutionConsent({ executor, timeoutMs: 100 });
  const result = assert.rejects(consent.run({ id: "task" }), /did not approve/);
  t.mock.timers.tick(100);
  await result;
  assert.equal(calls, 0);
  await new AgentExecutionConsent({ executor, automatic: true }).run({
    id: "task",
  });
  assert.equal(calls, 1);
});

test("invitations reject expiry, oversized values and unsafe destinations", () => {
  const now = Date.now();
  const pairing = {
    gatewayUrl: "wss://agents.example.com",
    code: "ABCDEFGHIJKL",
    expiresAt: now + 60_000,
  };
  assert.deepEqual(decodeAgentInvitation(encodeAgentInvitation(pairing), now), {
    gatewayUrl: pairing.gatewayUrl,
    pairingCode: pairing.code,
  });
  assert.throws(() =>
    decodeAgentInvitation(encodeAgentInvitation(pairing), now + 60_001),
  );
  for (const gatewayUrl of [
    "ws://public.example",
    "wss://user:pass@example.com",
    "wss://example.com?credential=secret",
  ]) {
    assert.throws(() =>
      decodeAgentInvitation(encodeAgentInvitation({ ...pairing, gatewayUrl })),
    );
  }
  assert.throws(() => decodeAgentInvitation("ido1." + "a".repeat(5000)));
  assert.throws(() => agentGuideComponents("javascript:alert(1)"));
  assert.equal(
    agentGuideComponents("https://example.com/join")[0].components[0].style,
    5,
  );
});

test("public deployment refuses unrestricted participants, host sandbox bypass and autonomous tasks", () => {
  const config = {
    workerGatewayEnabled: true,
    workerGatewayHost: "127.0.0.1",
    workerGatewayPublicUrl: "wss://agents.example.com",
    codexSandbox: "workspace-write",
    allParticipantsOperate: false,
    autonomousTasks: false,
  };
  assert.doesNotThrow(() => assertPublicWorkerPolicy(config));
  for (const change of [
    { allParticipantsOperate: true },
    { codexSandbox: "danger-full-access" },
    { autonomousTasks: true },
  ])
    assert.throws(() => assertPublicWorkerPolicy({ ...config, ...change }));
});

test("Gateway rejects browser-origin connections and caps unauthenticated connections", async (t) => {
  const gateway = new AgentWorkerGateway({
    registry: new AgentWorkerRegistry(),
    port: 0,
    maximumUnauthenticatedConnections: 1,
    logger: { warn() {} },
  });
  await gateway.start();
  t.after(() => gateway.stop());
  const url = `ws://127.0.0.1:${gateway.address().port}`;
  const browser = new WebSocket(url, { origin: "https://attacker.example" });
  const browserError = await new Promise((resolve) =>
    browser.once("error", resolve),
  );
  assert.match(browserError.message, /401/);
  const first = new WebSocket(url);
  await new Promise((resolve) => first.once("message", resolve));
  const serverSocket = [...gateway.sessions.keys()][0];
  const serverClosed = new Promise((resolve) =>
    serverSocket.once("close", resolve),
  );
  const second = new WebSocket(url);
  const capacityError = await new Promise((resolve) =>
    second.once("error", resolve),
  );
  assert.match(capacityError.message, /503/);
  first.close();
  await new Promise((resolve) => first.once("close", resolve));
  await serverClosed;
  assert.equal(gateway.sessions.size, 0);
});

test("Gateway closes a connection that exceeds its message budget", async (t) => {
  class Server extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit("listening"));
    }
    close(callback) {
      callback();
    }
  }
  class Socket extends EventEmitter {
    readyState = 1;
    send() {}
    close(code) {
      this.code = code;
      this.readyState = 3;
      this.emit("close");
    }
  }
  const gateway = new AgentWorkerGateway({
    registry: {},
    WebSocketServerClass: Server,
    maximumMessagesPerWindow: 2,
    logger: { warn() {} },
  });
  await gateway.start();
  t.after(() => gateway.stop());
  const socket = new Socket();
  gateway.server.emit("connection", socket);
  for (let i = 0; i < 3; i++) socket.emit("message", Buffer.from("{}"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(socket.code, 4002);
  assert.equal(gateway.sessions.size, 0);
});

test("removing an allowed owner blocks an already paired credential", async (t) => {
  let allowed = true;
  const registry = new AgentWorkerRegistry();
  const gateway = new AgentWorkerGateway({
    registry,
    port: 0,
    authorizeOwner: () => allowed,
    logger: { warn() {} },
  });
  await gateway.start();
  const pairing = await gateway.createPairing({
    ownerUserId: "123456789012345678",
  });
  const worker = new DiscordAgentWorker({
    gatewayUrl: `ws://127.0.0.1:${gateway.address().port}`,
    pairingCode: pairing.code,
    executor: {},
  });
  t.after(async () => {
    await worker.stop();
    await gateway.stop();
  });
  const credential = await worker.connect();
  await worker.stop();
  allowed = false;
  await assert.rejects(() =>
    gateway.createPairing({ ownerUserId: "123456789012345678" }),
  );
  const returning = new DiscordAgentWorker({ credential, executor: {} });
  t.after(() => returning.stop());
  await assert.rejects(returning.connect(), /rejected|closed/);
  await returning.stop();
});

test("Worker rejects unsolicited pairing and never starts a task before authentication", async (t) => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  for (const message of [
    {
      type: "paired",
      agentId: "member-123456789012345678",
      token: "a".repeat(43),
    },
    { type: "task", taskId: "task", leaseId: "lease" },
  ]) {
    server.once("connection", (socket) => socket.send(JSON.stringify(message)));
    let executions = 0;
    let writes = 0;
    const worker = new DiscordAgentWorker({
      gatewayUrl: `ws://127.0.0.1:${server.address().port}`,
      executor: { run: async () => ++executions },
      credentialWriter: async () => ++writes,
    });
    await assert.rejects(worker.connect(), /pairing|authentication/);
    await worker.stop();
    assert.equal(executions, 0);
    assert.equal(writes, 0);
  }
});
