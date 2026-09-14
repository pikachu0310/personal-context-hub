import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCommandApproval } from "../src/discord-agent-command-approval.mjs";
import { AgentPausableExecution } from "../src/discord-agent-pause.mjs";
import { AgentWorkerGateway } from "../src/discord-agent-worker-gateway.mjs";
import { agentInstallerHandler } from "../src/discord-agent-installer.mjs";
import { AgentSandboxSetup } from "../src/discord-agent-sandbox.mjs";
import { EventEmitter } from "node:events";

test("sandbox setup persists elevated mode only after successful setup and closes on failure", async () => {
  for (const success of [true, false]) {
    const client = new EventEmitter();
    const requests = [];
    let closed = false;
    client.request = async (method, params) => {
      requests.push({ method, params });
      if (method === "windowsSandbox/setupStart")
        queueMicrotask(() =>
          client.emit("notification", {
            method: "windowsSandbox/setupCompleted",
            params: { success },
          }),
        );
      return {};
    };
    client.close = async () => {
      closed = true;
    };
    const setup = new AgentSandboxSetup("isolated-home", {
      supported: true,
      createClient: () => client,
    });
    setup.start("sample-repository");
    setup.start("ignored-duplicate");
    await setup.done;
    assert.equal(requests.length, success ? 2 : 1);
    assert.equal(requests[0].params.mode, "elevated");
    assert.equal(setup.state.ready === true, success);
    assert.equal(setup.state.pending, false);
    assert.equal(closed, true);
  }
});

test("command approvals are per operation, expire, and are revoked on task cancellation", async () => {
  const prompts = new AgentCommandApproval({ timeoutMs: 20 });
  const controller = new AbortController();
  const first = prompts.request(
    "one",
    "item/commandExecution/requestApproval",
    { command: "git status", cwd: "sample" },
    controller.signal,
  );
  const second = prompts.request(
    "two",
    "item/commandExecution/requestApproval",
    { command: "git log" },
  );
  assert.equal(prompts.list().length, 2);
  const id = prompts.list()[0].id;
  assert.equal(prompts.decide(id, true), true);
  assert.deepEqual(await first, { decision: "accept" });
  assert.equal(prompts.decide(id, true), false);
  assert.deepEqual(await second, { decision: "decline" });
  const cancelled = prompts.request(
    "one",
    "item/fileChange/requestApproval",
    { grantRoot: "sample" },
    controller.signal,
  );
  controller.abort();
  assert.deepEqual(await cancelled, { decision: "decline" });
  assert.deepEqual(
    await prompts.request("one", "exec", { command: "unsafe" }),
    { decision: "decline" },
  );
  assert.equal(prompts.list().length, 0);
  assert.deepEqual(
    await prompts.request(
      "auto",
      "item/permissions/requestApproval",
      { permissions: { network: { enabled: true } } },
      undefined,
      { automatic: true },
    ),
    { decision: "accept" },
  );
  assert.equal(prompts.list().length, 0);
  assert.deepEqual(
    await prompts.request("auto", "unknown", {}, undefined, {
      automatic: true,
    }),
    { decision: "decline" },
  );
  assert.deepEqual(
    await prompts.request(
      "auto",
      "item/commandExecution/requestApproval",
      { command: "git status" },
      controller.signal,
      { automatic: true },
    ),
    { decision: "decline" },
  );
});

test("pause waits for the old execution to stop, resumes with explicit permissions, and final stop settles the lease", async () => {
  const states = [],
    permissions = [];
  let executions = 0,
    stopped = 0;
  const controller = new AbortController();
  const task = { id: "one" };
  const manager = new AgentPausableExecution({
    onState: (_id, state) => states.push(state),
    execute: async (received, { signal }, network) => {
      assert.equal(received, task);
      assert.equal(executions, stopped, "never overlap writers");
      executions++;
      permissions.push(network);
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      stopped++;
      signal.throwIfAborted();
    },
  });
  const completed = manager.run(task, { signal: controller.signal }, false);
  const rejected = assert.rejects(completed);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await manager.pause("one"), true);
  assert.equal(stopped, 1);
  assert.equal(states.at(-1), "paused");
  assert.equal(manager.resume("one", "true"), false);
  assert.equal(manager.resume("one", true), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(permissions, [false, true]);
  await manager.pause("one");
  controller.abort();
  await rejected;
  assert.equal(manager.resume("one", true), false);
  assert.equal(manager.runs.size, 0);
});

test("installer endpoint serves only the configured file and install guide without exposing arbitrary paths", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-installer-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "test.exe");
  const bytes = Buffer.from("MZsynthetic installer fixture");
  await writeFile(file, bytes);
  const gateway = new AgentWorkerGateway({
    registry: {},
    agentTeam: {},
    port: 0,
    publicUrl: "wss://agents.example.com/workers",
    installerPath: file,
  });
  await gateway.start();
  t.after(() => gateway.stop());
  const base = `http://127.0.0.1:${gateway.address().port}`;
  const guide = await fetch(base + "/agent");
  assert.equal(guide.status, 200);
  assert.match(await guide.text(), /\/agent\/installer.exe/);
  const download = await fetch(base + "/agent/installer.exe");
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  for (const path of [
    "/.env",
    "/auth.json",
    "/agent/installer.exe?path=../.env",
    "/agent/%2e%2e/profile.json",
  ])
    assert.equal((await fetch(base + path)).status, 404);
  assert.equal((await fetch(base + "/agent", { method: "POST" })).status, 405);
  const bad = join(directory, "bad.exe");
  await writeFile(bad, "not an exe");
  await assert.rejects(agentInstallerHandler(bad));
});
