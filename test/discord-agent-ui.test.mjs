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

test("desktop task API cancels only the selected task and shutdown waits for owned work", async (t) => {
  let execute;
  let stopped = 0;
  const { call, ui, url } = await fixture(t, {
    createWorker: ({ executor }) => {
      execute = executor;
      return {
        authenticated: true,
        connect: async () => {},
        stop: async () => {},
      };
    },
    createExecutor: () => ({
      run: async (_task, { signal, onProgress }) => {
        await onProgress("working");
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        await new Promise((resolve) => setImmediate(resolve));
        stopped++;
        signal.throwIfAborted();
      },
    }),
  });
  assert.equal(
    (
      await call("/connect", {
        gatewayUrl: "ws://127.0.0.1:8787/workers",
        pairingCode: "test-code",
        workingDirectory: "sample",
        automatic: true,
      })
    ).status,
    200,
  );
  const first = assert.rejects(execute.run({ id: "one", title: "one" }));
  const second = assert.rejects(execute.run({ id: "two", title: "two" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await call("/stop-task", { id: "unknown" })).status, 409);
  assert.equal((await call("/stop-task", { id: "one" })).status, 200);
  await first;
  const state = await (await call("/status")).json();
  assert.equal(
    state.tasks.find((task) => task.id === "one").state,
    "cancelled",
  );
  assert.equal(state.tasks.find((task) => task.id === "two").state, "running");
  await ui.close();
  await second;
  assert.equal(stopped, 2);
  await assert.rejects(fetch(new URL("/status", url)));
});

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
  for (const path of ["/join", "/join.js"]) {
    const landing = await fetch(new URL(path, url));
    assert.equal(landing.status, 200);
    assert.equal(landing.headers.get("referrer-policy"), "no-referrer");
    assert.equal(landing.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await landing.text(), new RegExp(url.hash.slice(1)));
  }
  assert.equal(
    (
      await fetch(new URL("/invitation", url), {
        method: "POST",
        headers: { Origin: url.origin, "Content-Type": "application/json" },
        body: JSON.stringify({ invitation: "ido1.example" }),
      })
    ).status,
    403,
  );
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

test("a fixed UI port rejects a second listener without moving invitations to a different port", async (t) => {
  const { directory, login, url } = await fixture(t);
  await assert.rejects(
    createAgentUi({ directory, login, port: Number(url.port) }),
    { code: "EADDRINUSE" },
  );
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
  assert.equal(
    (await call("/invitation", { invitation: encodeAgentInvitation(pairing) }))
      .status,
    409,
  );
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

test("UI rejects credential-bearing and ambiguous endpoints before creating a Worker", async (t) => {
  let created = 0;
  const { call } = await fixture(t, {
    createWorker: () => {
      created++;
      return {};
    },
    createExecutor: () => ({}),
  });
  for (const gatewayUrl of [
    "wss://user:secret@example.com",
    "wss://example.com/workers?secret=value",
    "wss://example.com/workers#secret",
    "wss://example.com/a/../workers",
  ]) {
    const response = await call("/connect", {
      gatewayUrl,
      workingDirectory: process.cwd(),
      pairingCode: "example",
    });
    assert.equal(response.status, 400);
    assert.doesNotMatch(await response.text(), /secret|example.com/);
  }
  assert.equal(created, 0);
});
