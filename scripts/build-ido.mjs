import { build } from "esbuild";
import { cp, mkdir, chmod, rm } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";

for (const name of ["engine", "client", "plugin-discord"]) {
  await rm(`packages/${name}/dist`, { recursive: true, force: true });
  const entryPoints =
    name === "plugin-discord"
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
  if (name !== "plugin-discord")
    await chmod(`packages/${name}/dist/cli.js`, 0o755);
}
const result = spawnSync(
  process.execPath,
  [
    "node_modules/vite/bin/vite.js",
    "build",
    "--config",
    "packages/dashboard/vite.config.ts",
  ],
  { stdio: "inherit" },
);
if (result.status !== 0) process.exit(result.status ?? 1);
for (const name of ["engine", "client"]) {
  await mkdir(`packages/${name}/dist/ui`, { recursive: true });
  await cp("packages/dashboard/dist", `packages/${name}/dist/ui`, {
    recursive: true,
  });
}
