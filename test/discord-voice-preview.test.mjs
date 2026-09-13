import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  TaskPreviewManager,
  parsePreviewCommand,
  formatTaskPreview,
} from "../src/discord-voice-preview.mjs";

test("preview starts only the configured sandbox command, verifies the version and rejects stale participant reports", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "preview-unit-"));
  const workspace = join(root, "task");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const launches = [];
  const manager = new TaskPreviewManager({
    command: ["node", "server.mjs", "{port}"],
    workspaceRoot: root,
    verify: async () => ({ passed: true, summary: "fixture click passed" }),
    fetchUrl: async () => ({ ok: true }),
    spawnProcess: (command, args, options) => {
      launches.push({ command, args, options });
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.kill = () => {
        child.signalCode = "SIGTERM";
        child.emit("exit");
        child.emit("close");
      };
      return child;
    },
  });
  t.after(() => manager.close());
  const task = {
    id: "task",
    workingDirectory: workspace,
    runRevision: 1,
    specRevision: 1,
    activeSpecRevision: 1,
  };
  const preview = await manager.start(task);
  assert.equal(preview.state, "available");
  assert.equal(preview.reachability, "local-only");
  assert.equal(preview.browserVerified, true);
  assert.equal(launches[0].args[0], "sandbox");
  assert.ok(
    launches[0].args.includes('permissions.idd-preview.extends=":workspace"'),
  );
  assert.equal(launches[0].options.env.OPENAI_API_KEY, undefined);
  assert.equal(await manager.confirm(task, 2, "a"), false);
  for (const userId of ["a", "a", "b", "c", "d"])
    assert.equal(await manager.confirm(task, 1, userId), true);
  assert.equal(preview.confirmations.length, 4);
  assert.equal(preview.reachability, "four-participants-confirmed");
  task.specRevision = 2;
  assert.equal(await manager.confirm(task, 1, "e"), false);
  await manager.stop(task.id, "superseded");
  assert.match(formatTaskPreview(preview), /停止済み/);
});

test("preview refuses an unrelated workspace and a shell string instead of argv", async (t) => {
  assert.throws(() => parsePreviewCommand('"npm run dev"'), /argv/);
  assert.throws(() => parsePreviewCommand('["npm","run","dev"]'), /port/);
  const root = await mkdtemp(join(tmpdir(), "preview-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = new TaskPreviewManager({
    command: ["node", "{port}"],
    workspaceRoot: root,
    spawnProcess: () => assert.fail("must not spawn"),
  });
  await assert.rejects(
    manager.start({ id: "bad", workingDirectory: tmpdir(), runRevision: 1 }),
    /configured task root/,
  );
});

test("concurrent stop and close wait until the preview process has exited", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "preview-stop-"));
  const workspace = join(root, "task");
  await mkdir(workspace);
  t.after(() => rm(root, { recursive: true, force: true }));
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  const signals = [];
  child.kill = (signal) => signals.push(signal);
  const manager = new TaskPreviewManager({
    command: ["node", "{port}"],
    workspaceRoot: root,
    fetchUrl: async () => ({ ok: true }),
    spawnProcess: () => child,
  });
  const task = { id: "task", workingDirectory: workspace, runRevision: 1 };
  await manager.start(task);
  const completed = [];
  const stop = manager.stop(task.id).then(() => completed.push("stop"));
  const close = manager.close().then(() => completed.push("close"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(completed, []);
  assert.deepEqual(signals, ["SIGTERM"]);
  child.signalCode = "SIGTERM";
  child.emit("close");
  await Promise.all([stop, close]);
  assert.equal(completed.length, 2);
});
