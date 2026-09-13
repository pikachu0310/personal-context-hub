import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { get } from "node:http";
import { AgentBrowserLogin } from "../src/discord-agent-login.mjs";
import { createAgentUi } from "../src/discord-agent-ui.mjs";
import { AgentWorkerRegistry } from "../src/discord-agent-worker-registry.mjs";
import { AgentWorkerGateway } from "../src/discord-agent-worker-gateway.mjs";
import { CodexAgentTeam } from "../src/discord-agent-team.mjs";
import { encodeAgentInvitation } from "../src/discord-agent-onboarding.mjs";

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => child.emit("close", 1);
  return child;
}

test("browser login delegates to Codex and exposes only an official URL and status", async () => {
  const children = [];
  const login = new AgentBrowserLogin({
    launcher: "codex-test",
    spawnProcess: (command, args, options) => {
      const child = fakeProcess();
      children.push({ child, command, args, options });
      return child;
    },
    env: {
      PATH: process.env.PATH,
      OPENAI_API_KEY: "do-not-pass",
      CODEX_HOME: "local-auth",
    },
  });
  login.start();
  assert.deepEqual(children[0].args, ["login"]);
  assert.equal(children[0].options.env.OPENAI_API_KEY, undefined);
  children[0].child.stdout.write(
    "https://attacker.example/secret https://auth.openai.com.attacker.example/secret ",
  );
  assert.equal(login.state.loginUrl, undefined);
  children[0].child.stdout.write(
    "https://auth.openai.com/authorize?state=example\n",
  );
  assert.equal(
    login.state.loginUrl,
    "https://auth.openai.com/authorize?state=example",
  );
  login.start();
  assert.equal(children.length, 1);
  children[0].child.emit("close", 0);
  assert.deepEqual(children[1].args, ["login", "status"]);
  children[1].child.stderr.write("Logged in: sensitive-auth-material");
  children[1].child.emit("close", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(login.state, { authenticated: true, pending: false });
});

async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), "agent-ui-test-"));
  const login = {
    state: { authenticated: true, pending: false },
    async refresh() {
      return this.state;
    },
    start() {
      this.state.pending = true;
    },
    stop() {},
  };
  const ui = await createAgentUi({
    directory,
    login,
    validateRepository: async () => {},
    ...extra,
  });
  const url = new URL(ui.url);
  const headers = {
    Authorization: `Bearer ${url.hash.slice(1)}`,
    Origin: url.origin,
    "Content-Type": "application/json",
  };
  t.after(async () => {
    await ui.close();
    await rm(directory, { recursive: true, force: true });
  });
  const call = (path, input, overrides = {}) =>
    fetch(new URL(path, url), {
      method: input === undefined ? "GET" : "POST",
      headers,
      body: input === undefined ? undefined : JSON.stringify(input),
      ...overrides,
    });
  return { ui, directory, login, url, headers, call };
}

test("local UI rejects cross-origin, missing capability, DNS rebinding and oversized requests", async (t) => {
  const { call, headers, url } = await fixture(t);
  assert.equal((await fetch(new URL("/status", url))).status, 403);
  assert.equal(
    (
      await call(
        "/login",
        {},
        { headers: { ...headers, Origin: "https://attacker.example" } },
      )
    ).status,
    403,
  );
  assert.equal(
    await new Promise((resolve, reject) => {
      get(
        new URL("/status", url),
        { headers: { ...headers, Host: "attacker.example" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      ).on("error", reject);
    }),
    403,
  );
  assert.equal(
    (
      await call(
        "/login",
        {},
        {
          headers: {
            Authorization: headers.Authorization,
            "Content-Type": "application/json",
          },
        },
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("/login", { long: "x".repeat(17_000) })).status,
    413,
  );
  const page = await fetch(url.origin);
  assert.match(
    page.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.doesNotMatch(await page.text(), new RegExp(url.hash.slice(1)));
  assert.equal((await call("/login", {})).status, 200);
});

test("two independent UI participants pair, receive separate tasks and reconnect without sharing auth", async (t) => {
  const registry = new AgentWorkerRegistry();
  const gateway = new AgentWorkerGateway({
    registry,
    agentTeam: new CodexAgentTeam([
      {
        id: "host",
        name: "Host",
        capabilities: ["*"],
        maximumConcurrentTasks: 1,
        workingDirectory: process.cwd(),
        enabled: true,
      },
    ]),
    host: "127.0.0.1",
    port: 0,
    publicUrl: "ws://127.0.0.1",
  });
  await gateway.start();
  t.after(() => gateway.stop());
  const gatewayUrl = `ws://127.0.0.1:${gateway.address().port}`;
  const participants = [];
  for (const ownerUserId of ["123456789012345678", "123456789012345679"]) {
    let credential;
    const pairing = registry.createPairing({
      ownerUserId,
      ownerDisplayName: "Example",
    });
    const setup = await fixture(t, {
      readCredential: async () => credential,
      writeCredential: async (value) => {
        credential = value;
      },
      createExecutor: () => ({
        run: async (task) => ({ result: `handled:${ownerUserId}:${task.id}` }),
      }),
    });
    const input = {
      workingDirectory: process.cwd(),
      gatewayUrl,
      pairingCode: pairing.code,
      automatic: true,
    };
    const response = await setup.call("/connect", input);
    assert.equal(response.status, 200, JSON.stringify(await response.json()));
    assert.equal((await (await setup.call("/status")).json()).connected, true);
    const disk = await readFile(join(setup.directory, "profile.json"), "utf8");
    assert.ok(!disk.includes(pairing.code));
    assert.ok(!disk.includes(credential.token));
    assert.ok(!disk.includes("privateKey"));
    participants.push({ setup, input, ownerUserId, credential });
  }
  const results = await Promise.all(
    participants.map(({ credential, ownerUserId }) =>
      gateway.runTask({
        id: `test-${ownerUserId}`,
        title: "Test",
        request: "Synthetic task",
        assignedAgentId: credential.agentId,
      }),
    ),
  );
  for (let i = 0; i < results.length; i++)
    assert.match(results[i], new RegExp(participants[i].ownerUserId));
  for (const { setup, input } of participants) {
    assert.equal((await setup.call("/stop", {})).status, 200);
    assert.equal(
      (
        await setup.call("/connect", {
          ...input,
          pairingCode: "",
          gatewayUrl: "wss://different.example",
        })
      ).status,
      400,
    );
    assert.equal(
      (await setup.call("/connect", { ...input, pairingCode: "" })).status,
      200,
    );
    assert.equal((await setup.call("/stop", {})).status, 200);
  }
});

test("UI fails closed before authentication and on expired pairing without leaking remote errors", async (t) => {
  const { call, login } = await fixture(t, {
    createWorker: () => ({
      connect: async () => {
        throw new Error("秘密のリモートエラー");
      },
      stop: async () => {},
    }),
    createExecutor: () => ({}),
  });
  const input = {
    workingDirectory: process.cwd(),
    gatewayUrl: "wss://agents.example.com",
    pairingCode: "example",
  };
  login.state.authenticated = false;
  assert.equal((await call("/connect", input)).status, 400);
  login.state.authenticated = true;
  assert.equal(
    (await call("/connect", { ...input, gatewayUrl: "ws://example.com" }))
      .status,
    400,
  );
  const failed = await call("/connect", input);
  assert.equal(failed.status, 400);
  assert.doesNotMatch(await failed.text(), /秘密/);
});

test("browser approval gates execution and permission choices are not persisted", async (t) => {
  let workerOptions;
  let executorOptions;
  let executions = 0;
  const { call, directory } = await fixture(t, {
    createExecutor: (options) => {
      executorOptions = options;
      return { run: async () => ++executions };
    },
    createWorker: (options) => {
      workerOptions = options;
      return {
        authenticated: true,
        socket: { readyState: 1 },
        connect: async () => ({}),
        stop: async () => {},
      };
    },
  });
  const pairing = {
    gatewayUrl: "wss://agents.example.com",
    code: "ABCDEFGHIJKL",
    expiresAt: Date.now() + 30_000,
  };
  const imported = await (
    await call("/invitation", { invitation: encodeAgentInvitation(pairing) })
  ).json();
  assert.equal(imported.pairingCode, pairing.code);
  assert.equal(
    (await call("/connect", { ...imported, workingDirectory: process.cwd() }))
      .status,
    200,
  );
  assert.equal(executorOptions.networkAccess, false);
  assert.equal(executorOptions.codexHome, join(directory, "codex-home"));
  const task = workerOptions.executor.run({ id: "task", request: "Run tests" });
  assert.equal(executions, 0);
  const state = await (await call("/status")).json();
  assert.equal(state.approvals.length, 1);
  assert.equal(
    (await call("/approve", { id: state.approvals[0].id, approved: true }))
      .status,
    200,
  );
  assert.equal(await task, 1);
  assert.equal(
    (await call("/approve", { id: state.approvals[0].id, approved: true }))
      .status,
    409,
  );
  assert.equal((await call("/stop", {})).status, 200);
  const disk = JSON.parse(
    await readFile(join(directory, "profile.json"), "utf8"),
  );
  assert.equal(disk.automatic, undefined);
  assert.equal(disk.networkAccess, undefined);
});
