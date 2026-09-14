import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";

const root = fileURLToPath(new URL("../../../", import.meta.url));

test("consumers resolve compiled common UI, CSS and declarations through package exports", async () => {
  const result = await build({
    absWorkingDir: root,
    stdin: {
      contents:
        'export { Card, Workspace } from "@ido/common-ui"; import "@ido/common-ui/style.css";',
      resolveDir: resolve(root, "packages/client"),
    },
    bundle: true,
    write: false,
    outdir: "unused",
    metafile: true,
    format: "esm",
    platform: "browser",
    external: ["react", "react-dom", "@mantine/core", "@mantine/hooks"],
  });
  const inputs = Object.keys(result.metafile.inputs);
  assert.ok(inputs.includes("packages/common-ui/dist/index.js"));
  assert.ok(inputs.includes("packages/common-ui/dist/style.css"));
  assert.ok(
    !inputs.some((path) => /packages\/(common-ui|common)\/src\//.test(path)),
  );
  assert.equal(
    await readFile(resolve(root, "packages/common-ui/dist/style.css"), "utf8"),
    await readFile(resolve(root, "packages/common-ui/src/style.css"), "utf8"),
  );
  const containingFile = resolve(root, "packages/client/src/ui/App.tsx");
  const options = { moduleResolution: ts.ModuleResolutionKind.Bundler };
  const resolved = ts.resolveModuleName(
    "@ido/common-ui",
    containingFile,
    options,
    ts.sys,
  );
  assert.equal(
    resolved.resolvedModule?.resolvedFileName.replaceAll("\\", "/"),
    resolve(root, "packages/common-ui/dist/types/index.d.ts").replaceAll(
      "\\",
      "/",
    ),
  );
  assert.equal(
    ts.resolveModuleName(
      "@ido/common-ui/src/index.ts",
      containingFile,
      options,
      ts.sys,
    ).resolvedModule,
    undefined,
  );
});
