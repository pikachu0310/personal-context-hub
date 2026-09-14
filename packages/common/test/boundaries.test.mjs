import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkBoundaries } from "../../../scripts/check-boundaries.mjs";
test("build rejects adapter imports in use cases, plugin coupling and UI networking", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ido-boundaries-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "engine/src/processing"), { recursive: true });
  const path = join(root, "engine/src/processing/work.ts");
  await writeFile(
    path,
    'import type { Repository } from "../ports/repository.js";',
  );
  await checkBoundaries(root);
  await writeFile(path, 'import { Store } from "../adapters/sqlite/store.js";');
  await assert.rejects(
    checkBoundaries(root),
    /Architecture boundary violations/,
  );
  await writeFile(path, 'import OpenAI from "openai";');
  await assert.rejects(checkBoundaries(root), /openai/);
  await writeFile(path, "");
  await mkdir(join(root, "plugin-third/src"), { recursive: true });
  const plugin = join(root, "plugin-third/src/index.ts");
  await writeFile(
    plugin,
    'export { Engine } from "../../engine/src/index.js";',
  );
  await assert.rejects(checkBoundaries(root), /plugin-third/);
  await writeFile(plugin, "");
  await mkdir(join(root, "ui/src"), { recursive: true });
  await writeFile(join(root, "ui/src/view.tsx"), 'fetch("/api/state");');
  await assert.rejects(
    checkBoundaries(root),
    /UI must receive data and actions/,
  );
});
