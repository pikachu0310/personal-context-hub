import assert from "node:assert/strict";
import test from "node:test";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src/", import.meta.url));
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
      if (dependency.startsWith("node:")) continue;
      assert.ok(
        dependency.startsWith("."),
        `${relative(src, file)} imports package ${dependency}`,
      );
      assert.ok(
        resolve(dirname(file), dependency).startsWith(
          resolve(src, "engine") + "/",
        ),
        `${relative(src, file)} escapes the engine: ${dependency}`,
      );
    }
  }
});
test("device adapters cannot transitively load execution SDKs or runtime composition", async () => {
  const seen = new Set();
  async function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    for (const dependency of await imports(file)) {
      assert.doesNotMatch(dependency, /@openai\/codex-sdk|^openai$/);
      if (!dependency.startsWith(".")) continue;
      const target = resolve(dirname(file), dependency);
      assert.doesNotMatch(
        relative(src, target),
        /^(execution|runtime|providers)\//,
      );
      await visit(target);
    }
  }
  for (const file of await modules(resolve(src, "adapters"))) await visit(file);
});
