import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { previewFixture, until } from "./preview-fixture.js";
import { launchPlan, LocalPreviews } from "../src/preview/local.js";
import { captureOptions } from "../src/preview/capture.js";

test("two local previews share agent slots, deduplicate start and terminate owned servers", async (t) => {
  const f = await previewFixture();
  t.after(f.close);
  const manager = f.client.localPreviews;
  manager.capture = async (_url, input) => ({
    bytes: Buffer.from("image"),
    ...captureOptions(input),
  });
  const reference = { projectId: "p", implementationIds: ["a", "b"] };
  assert.equal(
    (await f.post("previews/prepare", { ...reference, owner: "screen" }, "bad"))
      .status,
    403,
  );
  const views = await manager.prepare(reference, "screen");
  await until(() =>
    manager.list("screen").every((v) => v.state === "prepared"),
  );
  await Promise.all([
    manager.start(views[0].id, "screen"),
    manager.start(views[0].id, "screen"),
    manager.start(views[1].id, "screen"),
  ]);
  await until(() => manager.list("screen").every((v) => v.state === "running"));
  assert.equal(f.launches.length, 2);
  assert.equal(f.maxPlanning(), 1);
  const running = manager.list("screen");
  assert.notEqual(running[0].url, running[1].url);
  assert.match(await (await fetch(running[0].url!)).text(), /案A/);
  assert.match(await (await fetch(running[1].url!)).text(), /案B/);
  assert.equal(manager.allows(running[0].url!), true);
  assert.equal(manager.allows(f.client.origin), false);
  assert.deepEqual(
    (f.launches[0].policy as { networkAccess: boolean }).networkAccess,
    false,
  );
  await until(() => manager.list("screen").every((v) => !!v.capture));
  await manager.takeCapture(
    views[0].id,
    { path: "/settings", width: 640, height: 480 },
    "screen",
  );
  assert.equal(manager.list("screen")[0].capture?.path, "/settings");
  let finish!: () => void;
  manager.capture = async (_url, input) => {
    if (input.path === "/slow")
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    return { bytes: Buffer.from("image"), ...captureOptions(input) };
  };
  const slow = manager.takeCapture(views[0].id, { path: "/slow" }, "screen");
  const nextCapture = manager.takeCapture(
    views[0].id,
    { path: "/latest" },
    "screen",
  );
  finish();
  await Promise.all([slow, nextCapture]);
  assert.equal(manager.list("screen")[0].capture?.path, "/latest");
  await manager.prepare(reference, "other-screen");
  await manager.release("screen");
  assert.ok(manager.list("other-screen").every((v) => v.state === "running"));
  await manager.release("other-screen");
  for (const view of running) {
    assert.equal(manager.allows(view.url!), false);
    await assert.rejects(fetch(view.url!));
  }
  const restored = new LocalPreviews(f.client);
  await restored.load();
  assert.ok(
    [...restored.entries.values()].every(
      (e) => e.view.state === "stopped" && !e.view.url,
    ),
  );
  await restored.close();
});
test("one failed launch does not close the other; source changes block launch without reverting", async (t) => {
  const f = await previewFixture();
  t.after(f.close);
  const manager = f.client.localPreviews;
  manager.capture = async (_url, input) => ({
    bytes: Buffer.from("image"),
    ...captureOptions(input),
  });
  const views = await manager.prepare(
    { projectId: "p", implementationIds: ["a", "b"] },
    "screen",
  );
  await until(() =>
    manager.list("screen").every((v) => v.state === "prepared"),
  );
  await manager.start(views[0].id, "screen");
  await until(() => manager.list("screen")[0].state === "running");
  f.plans.failure = true;
  await manager.start(views[1].id, "screen");
  await until(() => manager.list("screen")[1].state === "failed");
  assert.equal(manager.list("screen")[0].state, "running");
  f.plans.failure = false;
  f.plans.mutate = true;
  await until(() => !manager.entries.get(views[1].id)?.job);
  await manager.start(views[1].id, "screen");
  await until(
    () => manager.list("screen")[1].error === "PREVIEW_WORKTREE_CHANGED",
  );
  assert.equal(
    await readFile(manager.list("screen")[1].directory + "/index.html", "utf8"),
    "changed",
  );
  assert.equal(manager.list("screen")[0].state, "running");
});
test("invalid command shapes, paths and dimensions fail before execution", () => {
  for (const value of [
    {},
    { setup: [], command: ["node\0bad"], cwd: ".", error: "" },
    { setup: [], command: ["node"], cwd: "/tmp", error: "" },
  ])
    assert.throws(() => launchPlan(value));
  assert.throws(() => captureOptions({ path: "//external.example" }));
  assert.throws(() => captureOptions({ width: 100000 }));
});

test("closing during preparation or while queued prevents late starts", async (t) => {
  const f = await previewFixture();
  t.after(f.close);
  const manager = f.client.localPreviews;
  const original = manager.repositories.prepare.bind(manager.repositories);
  manager.repositories.prepare = async (
    _artifact,
    _directory,
    _mapping,
    signal,
  ) =>
    new Promise((_resolve, reject) => {
      if (signal?.aborted) reject(new Error("PREVIEW_STOPPED"));
      else
        signal?.addEventListener(
          "abort",
          () => reject(new Error("PREVIEW_STOPPED")),
          { once: true },
        );
    });
  const views = await manager.prepare(
    { projectId: "p", implementationIds: ["a"] },
    "screen",
  );
  await manager.release("screen");
  assert.equal(manager.entries.get(views[0].id)!.view.state, "stopped");
  assert.equal(f.launches.length, 0);
  manager.repositories.prepare = original;
  const next = await manager.prepare(
    { projectId: "p", implementationIds: ["b"] },
    "next",
  );
  await until(() => manager.list("next")[0].state === "prepared");
  f.client.settings.slots = 0;
  await manager.start(next[0].id, "next");
  await manager.release("next");
  assert.equal(manager.entries.get(next[0].id)!.view.state, "stopped");
  assert.equal(f.launches.length, 0);
});
