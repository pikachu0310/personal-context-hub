import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import { validateAgentEndpoint } from "../src/discord-agent-endpoint.mjs";
import { inspectAgentHost } from "../src/discord-agent-host-inspection.mjs";
import { AgentWorkerGateway } from "../src/discord-agent-worker-gateway.mjs";
import { AgentWorkerRegistry } from "../src/discord-agent-worker-registry.mjs";
import { DiscordAgentWorker } from "../src/discord-agent-worker.mjs";
import {
  encodeAgentInvitation,
  decodeAgentInvitation,
} from "../src/discord-agent-onboarding.mjs";

const unsafeUrls = [
  "ws://public.example/workers",
  "https://example.com/workers",
  "wss://user:secret@example.com/workers",
  "wss://example.com/workers?token=secret",
  "wss://example.com/workers#secret",
  "wss://example.com/workers?",
  "wss://example.com/workers#",
  "wss://example.com/./workers",
  "wss://example.com/a/../workers",
  "wss://example.com/%77orkers",
  "wss://example.com/workers%2fjoin",
  "wss://example.com\\workers",
  "wss://example.com/work\ners",
];

test("Worker and invitation endpoint validation reject unsafe URLs before opening any socket", () => {
  let opened = 0;
  class Socket {
    constructor() {
      opened++;
    }
  }
  for (const url of unsafeUrls) {
    assert.throws(() => validateAgentEndpoint(url));
    assert.throws(() =>
      decodeAgentInvitation(
        encodeAgentInvitation({
          gatewayUrl: url,
          code: "ABCDEFGHIJKL",
          expiresAt: Date.now() + 60_000,
        }),
      ),
    );
    const worker = new DiscordAgentWorker({
      gatewayUrl: url,
      WebSocketClass: Socket,
    });
    assert.throws(() => worker.connect());
  }
  assert.equal(opened, 0);
  assert.equal(validateAgentEndpoint("ws://[::1]:8787/workers").loopback, true);
  assert.equal(
    validateAgentEndpoint("wss://agents.example.com/workers").path,
    "/workers",
  );
});

async function host(t, extra = {}) {
  const gateway = new AgentWorkerGateway({
    registry: new AgentWorkerRegistry(),
    port: 0,
    publicUrl: "wss://agents.example.com/workers",
    logger: { warn() {} },
    ...extra,
  });
  await gateway.start();
  t.after(() => gateway.stop());
  const base = `ws://127.0.0.1:${gateway.address().port}`;
  return { gateway, base };
}

test("only the literal Worker path accepts an upgrade; forwarding headers grant no access", async (t) => {
  const { gateway, base } = await host(t);
  for (const [path, headers, status] of [
    ["/", {}, 404],
    ["/join", {}, 404],
    ["/status", {}, 404],
    ["/workers/", {}, 404],
    ["/workers?token=secret", {}, 404],
    ["/%77orkers", {}, 404],
    ["/workers", { Origin: "" }, 401],
    ["/workers", { Origin: "https://example.com" }, 401],
    ["/workers", { "Sec-WebSocket-Origin": "null" }, 401],
    ["/workers", { "Sec-WebSocket-Protocol": "secret" }, 401],
  ]) {
    const socket = new WebSocket(base + path, {
      headers: {
        ...headers,
        "X-Forwarded-For": "127.0.0.1",
        "CF-Connecting-IP": "127.0.0.1",
      },
    });
    const error = await new Promise((resolve) => socket.once("error", resolve));
    assert.match(error.message, new RegExp(String(status)));
    assert.equal(gateway.sessions.size, 0);
  }
  const response = await fetch(base.replace("ws:", "http:") + "/status");
  assert.notEqual(response.status, 200);
  const socket = new WebSocket(base + "/workers");
  const [data] = await once(socket, "message");
  assert.equal(JSON.parse(data).type, "challenge");
  socket.close();
  await once(socket, "close");
});

test("oversized input closes only the offending connection and the Gateway remains available", async (t) => {
  const { base } = await host(t);
  const first = new WebSocket(base + "/workers");
  await once(first, "message");
  first.send(Buffer.alloc(256 * 1024 + 1));
  await once(first, "close");
  const second = new WebSocket(base + "/workers");
  const [data] = await once(second, "message");
  assert.equal(JSON.parse(data).type, "challenge");
  second.close();
  await once(second, "close");
});

test("shutdown terminates a peer which never acknowledges the close handshake", async (t) => {
  const { gateway } = await host(t);
  const socket = connect({ host: "127.0.0.1", port: gateway.address().port });
  t.after(() => socket.destroy());
  await once(socket, "connect");
  socket.write(
    `GET /workers HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\n\r\n`,
  );
  const [response] = await once(socket, "data");
  assert.match(response.toString(), /101 Switching Protocols/);
  const before = Date.now();
  await gateway.stop();
  assert.ok(Date.now() - before < 5000);
});

test("cancelled tasks never dispatch and failed sends do not retain task leases", async () => {
  const gateway = new AgentWorkerGateway({ registry: {} });
  let sends = 0;
  gateway.connections.set("agent", {
    readyState: 1,
    send() {
      sends++;
      throw new Error("private socket error");
    },
  });
  const task = { id: "task", assignedAgentId: "agent" };
  await assert.rejects(gateway.runTask(task, { signal: AbortSignal.abort() }), {
    name: "AbortError",
  });
  assert.equal(sends, 0);
  await assert.rejects(gateway.runTask(task), { code: "WORKER_DISCONNECTED" });
  assert.equal(sends, 1);
  assert.equal(gateway.pending.size, 0);
});

test("two participants exchange tasks on the configured path without sharing identities", async (t) => {
  const { gateway, base } = await host(t);
  const workers = [];
  for (const ownerUserId of ["123456789012345678", "123456789012345679"]) {
    const pairing = await gateway.createPairing({ ownerUserId });
    assert.ok(pairing.gatewayUrl.endsWith("/workers"));
    const worker = new DiscordAgentWorker({
      gatewayUrl: base + "/workers",
      pairingCode: pairing.code,
      executor: {
        run: async (task) => ({ result: `${task.agentId}:${task.id}` }),
      },
    });
    await worker.connect();
    workers.push(worker);
    t.after(() => worker.stop());
  }
  const result = await Promise.all(
    workers.map((worker, i) =>
      gateway.runTask({
        id: `task-${i}`,
        assignedAgentId: worker.credential.agentId,
      }),
    ),
  );
  assert.equal(result[0], `${workers[0].credential.agentId}:task-0`);
  assert.equal(result[1], `${workers[1].credential.agentId}:task-1`);
  assert.notEqual(workers[0].credential.token, workers[1].credential.token);
});

test("host inspection separates settings from reachability and never returns secrets or local identifiers", () => {
  const env = {
    PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_ENABLED: "true",
    PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_HOST: "127.0.0.1",
    PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_PORT: "8787",
    PERSONAL_CONTEXT_VOICE_ALL_PARTICIPANTS_OPERATE: "false",
    PERSONAL_CONTEXT_VOICE_AUTONOMOUS_TASKS: "false",
    PERSONAL_CONTEXT_VOICE_CODEX_SANDBOX: "workspace-write",
    OPENAI_API_KEY: "sensitive-api-key",
  };
  const local = inspectAgentHost(env);
  assert.equal(local.localConfigPassed, true);
  assert.equal(local.publicEndpointConfigured, false);
  const publicConfig = inspectAgentHost({
    ...env,
    PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_PUBLIC_URL:
      "wss://private-project.example/workers",
  });
  assert.equal(publicConfig.publicEndpointConfigured, true);
  assert.equal(publicConfig.externalReachability, "not_tested");
  assert.equal(publicConfig.externalCalls, 0);
  assert.doesNotMatch(
    JSON.stringify(publicConfig),
    /private-project|sensitive-api-key/,
  );
  for (const [key, value] of [
    ["WORKER_GATEWAY_HOST", "0.0.0.0"],
    ["WORKER_GATEWAY_PORT", "17879"],
    ["ALL_PARTICIPANTS_OPERATE", "true"],
    ["AUTONOMOUS_TASKS", "true"],
    ["CODEX_SANDBOX", "danger-full-access"],
  ]) {
    assert.equal(
      inspectAgentHost({ ...env, [`PERSONAL_CONTEXT_VOICE_${key}`]: value })
        .localConfigPassed,
      false,
    );
  }
  const invalid = inspectAgentHost({
    ...env,
    PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_PUBLIC_URL:
      "wss://user:do-not-display@example.com?secret=hide",
  });
  assert.equal(invalid.publicEndpointConfigured, false);
  assert.doesNotMatch(JSON.stringify(invalid), /do-not-display|secret=hide/);
});
