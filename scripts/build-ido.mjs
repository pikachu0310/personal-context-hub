import { checkBoundaries } from "./check-boundaries.mjs";
await checkBoundaries();
await import("./build-common-ui.mjs");
import { build } from "esbuild";
import { cp, mkdir, chmod, rm } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";

for (const name of ["engine", "client", "plugin-discord", "plugin-dashboard"]) {
  await rm(`packages/${name}/dist`, { recursive: true, force: true });
  const entryPoints = name.startsWith("plugin-")
    ? ["index"]
    : name === "engine"
      ? ["cli", "index", "tunnel-worker"]
      : ["cli", "index"];
  const result = await build({
    metafile: true,
    entryPoints: entryPoints.map((entry) => `packages/${name}/src/${entry}.ts`),
    outdir: `packages/${name}/dist`,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    sourcemap: true,
    external: [
      "openai",
      "ws",
      "discord.js",
      "@discordjs/voice",
      "prism-media",
      "opusscript",
      "@openai/codex",
    ],
  });
  for (const input of Object.keys(result.metafile.inputs)) {
    const path = relative(resolve("packages"), resolve(input));
    if (
      isAbsolute(path) ||
      path === ".." ||
      path.startsWith("../") ||
      path.startsWith("..\\")
    )
      throw new Error(`Runtime source outside packages: ${input}`);
  }
  if (!name.startsWith("plugin-"))
    await chmod(`packages/${name}/dist/cli.js`, 0o755);
}
for (const name of ["engine", "client", "plugin-dashboard", "plugin-discord"]) {
  const result = spawnSync(
    process.execPath,
    [
      "node_modules/vite/bin/vite.js",
      "build",
      "--config",
      `packages/${name}/vite.config.ts`,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
}
await mkdir("packages/engine/dist/plugins/dashboard", { recursive: true });
await cp(
  "packages/plugin-dashboard/dist",
  "packages/engine/dist/plugins/dashboard",
  { recursive: true },
);
