import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("common exports resolve compiled modules and declarations without a TypeScript loader", async () => {
  const manifest = JSON.parse(
    await readFile(resolve(root, "packages/common/package.json"), "utf8"),
  );
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler };
  const consumer = resolve(root, "packages/engine/src/index.ts");
  const specifiers = [];
  for (const [entry, target] of Object.entries(manifest.exports)) {
    const specifier = entry.replace(".", "@ido/common");
    specifiers.push(specifier);
    assert.equal(
      fileURLToPath(import.meta.resolve(specifier)),
      resolve(root, "packages/common", target.import),
    );
    assert.equal(
      ts
        .resolveModuleName(specifier, consumer, options, ts.sys)
        .resolvedModule?.resolvedFileName.replaceAll("\\", "/"),
      resolve(root, "packages/common", target.types).replaceAll("\\", "/"),
    );
  }
  for (const path of [
    "src/contracts/protocol.js",
    "dist/contracts/protocol.js",
  ])
    assert.throws(() => import.meta.resolve(`@ido/common/${path}`), {
      code: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    });
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `for (const name of ${JSON.stringify(specifiers)}) await import(name);`,
    ],
    { cwd: root },
  );
});

test("browser consumers bundle common contracts and browser API without Node runtime code", async () => {
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents:
        'export { frame } from "@ido/common/contracts/protocol"; export { browserApi } from "@ido/common/runtime/browser-api";',
      resolveDir: resolve(root, "packages/client"),
    },
    bundle: true,
    write: false,
    metafile: true,
    platform: "browser",
    format: "esm",
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.includes("packages/common/dist/contracts/protocol.js"));
  assert.ok(inputs.includes("packages/common/dist/runtime/browser-api.js"));
  assert.ok(!inputs.some((path) => path.includes("common/src/")));
  assert.ok(
    !inputs.some((path) =>
      /runtime\/(platform|credentials|codex)\b/.test(path),
    ),
  );
});
