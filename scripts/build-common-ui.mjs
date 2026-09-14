import { execFileSync } from "node:child_process";
import { copyFile, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await import("./build-common.mjs");

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = resolve(root, "packages/common-ui");
await rm(resolve(directory, "dist"), { recursive: true, force: true });
await mkdir(resolve(directory, "dist"), { recursive: true });
await build({
  absWorkingDir: root,
  entryPoints: ["packages/common-ui/src/index.ts"],
  outfile: "packages/common-ui/dist/index.js",
  bundle: true,
  packages: "external",
  platform: "browser",
  format: "esm",
  target: "es2023",
  jsx: "automatic",
});
execFileSync(
  process.execPath,
  [
    resolve(root, "node_modules/typescript/bin/tsc"),
    "-p",
    resolve(directory, "tsconfig.build.json"),
  ],
  { cwd: root, stdio: "inherit" },
);
await copyFile(
  resolve(directory, "src/style.css"),
  resolve(directory, "dist/style.css"),
);
