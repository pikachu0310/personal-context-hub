import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import path, { resolve, posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));
const forbiddenAdapterLayers = new Set(["execution", "runtime", "providers"]);

function dependencyLayer(root, target, paths) {
  return paths.relative(root, target).split(paths.sep)[0];
}

function assertEngineImport(root, file, dependency, paths = path) {
  if (dependency.startsWith("node:")) return;
  assert.ok(
    dependency.startsWith("."),
    `${paths.relative(root, file)} imports package ${dependency}`,
  );
  const target = paths.resolve(paths.dirname(file), dependency);
  assert.equal(
    dependencyLayer(root, target, paths),
    "engine",
    `${paths.relative(root, file)} escapes the engine: ${dependency}`,
  );
}

function assertAdapterImport(root, file, dependency, paths = path) {
  assert.doesNotMatch(dependency, /@openai\/codex-sdk|^openai$/);
  if (!dependency.startsWith(".")) return;
  const target = paths.resolve(paths.dirname(file), dependency);
  assert.ok(
    !forbiddenAdapterLayers.has(dependencyLayer(root, target, paths)),
    `${paths.relative(root, file)} imports forbidden layer: ${dependency}`,
  );
  return target;
}

async function modules(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map((entry) =>
        entry.isDirectory()
          ? modules(resolve(directory, entry.name))
          : entry.name.endsWith(".mjs")
            ? [resolve(directory, entry.name)]
            : [],
      ),
    )
  ).flat();
}
async function imports(file) {
  const source = await readFile(file, "utf8");
  return [
    ...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g),
  ].map((match) => match[1]);
}
test("engine imports only engine modules and platform primitives", async () => {
  for (const file of await modules(resolve(src, "engine"))) {
    for (const dependency of await imports(file)) {
      assertEngineImport(src, file, dependency);
    }
  }
});
test("device adapters cannot transitively load execution SDKs or runtime composition", async () => {
  const seen = new Set();
  async function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const dependency of await imports(file)) {
      const target = assertAdapterImport(src, file, dependency);
      if (target) await visit(target);
    }
  }
  for (const file of await modules(resolve(src, "adapters"))) await visit(file);
});

for (const [platform, paths, root] of [
  ["POSIX", posix, "/architecture-fixture/src"],
  ["Windows", win32, "C:\\architecture-fixture\\src"],
]) {
  test(`engine boundaries allow internal imports and reject escapes on ${platform}`, () => {
    const file = paths.join(root, "engine/input/port.mjs");
    for (const dependency of [
      "./audio.mjs",
      "../turn-session.mjs",
      "node:fs",
    ]) {
      assert.doesNotThrow(() =>
        assertEngineImport(root, file, dependency, paths),
      );
    }
    for (const dependency of [
      "../../engine-extra/helper.mjs",
      "../../providers/audio.mjs",
      "../../../outside.mjs",
      "discord.js",
    ]) {
      assert.throws(
        () => assertEngineImport(root, file, dependency, paths),
        assert.AssertionError,
      );
    }
  });

  test(`adapter boundaries reject forbidden layers and SDKs on ${platform}`, () => {
    const file = paths.join(root, "adapters/discord/transport.mjs");
    for (const dependency of [
      "../../engine/conversation.mjs",
      "../../execution-tools/helper.mjs",
      "discord.js",
      "node:fs",
    ]) {
      assert.doesNotThrow(() =>
        assertAdapterImport(root, file, dependency, paths),
      );
    }
    // Apply the same rule to a helper reached during transitive traversal.
    const helper = paths.join(root, "shared/helper.mjs");
    for (const layer of ["execution", "runtime", "providers"]) {
      for (const [importer, dependency] of [
        [file, `../../${layer}/module.mjs`],
        [helper, `../${layer}/nested/module.mjs`],
      ]) {
        assert.throws(
          () => assertAdapterImport(root, importer, dependency, paths),
          /imports forbidden layer/,
        );
      }
    }
    for (const dependency of ["@openai/codex-sdk", "openai"]) {
      assert.throws(
        () => assertAdapterImport(root, helper, dependency, paths),
        assert.AssertionError,
      );
    }
  });
}
