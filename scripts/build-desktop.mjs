import { build } from "esbuild";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
const require = createRequire(import.meta.url);
const root = resolve(".ido-build/desktop");
const stage = resolve(root, "app");
if (!stage.startsWith(root + sep)) throw new Error("INVALID_BUILD_PATH");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await build({
  entryPoints: ["packages/desktop/src/main.ts"],
  outfile: `${stage}/main.js`,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  external: [
    "electron",
    "ws",
    "@openai/codex",
    "playwright",
    "@anthropic-ai/claude-agent-sdk",
    "zod",
  ],
});
await cp("packages/client/dist/ui", `${stage}/ui`, { recursive: true });
await cp("packages/desktop/src/preload.cjs", `${stage}/preload.cjs`);
await cp("packages/desktop/assets/icon.ico", `${stage}/icon.ico`);
const native = `@openai/codex-${process.platform}-${process.arch}`;
const dependencies = {};
for (const name of ["ws", native]) {
  const source = dirname(require.resolve(`${name}/package.json`));
  const dependency = JSON.parse(
    await readFile(`${source}/package.json`, "utf8"),
  );
  dependencies[name] =
    name === native
      ? `npm:@openai/codex@${dependency.version}`
      : dependency.version;
  await mkdir(dirname(`${stage}/node_modules/${name}`), { recursive: true });
  await cp(source, `${stage}/node_modules/${name}`, { recursive: true });
}
const pkg = JSON.parse(await readFile("packages/desktop/package.json", "utf8"));
// SDK includes a native runtime and public peer dependencies; retain their
// package layout instead of bundling code that resolves resources at runtime.
const copied = new Set();
async function copyDependency(name, resolver = require) {
  if (copied.has(name)) return;
  let manifest;
  try {
    manifest = resolver.resolve(`${name}/package.json`);
  } catch {
    let current = dirname(resolver.resolve(name));
    while (true) {
      try {
        const candidate = JSON.parse(
          await readFile(`${current}/package.json`, "utf8"),
        );
        if (candidate.name === name) {
          manifest = `${current}/package.json`;
          break;
        }
      } catch {
        /* Find the owning package. */
      }
      const parent = dirname(current);
      if (parent === current)
        throw new Error(`Dependency manifest unavailable: ${name}`);
      current = parent;
    }
  }
  const source = dirname(manifest);
  const metadata = JSON.parse(await readFile(manifest, "utf8"));
  copied.add(name);
  await mkdir(dirname(`${stage}/node_modules/${name}`), { recursive: true });
  await cp(source, `${stage}/node_modules/${name}`, { recursive: true });
  const nextResolver = createRequire(manifest);
  for (const child of Object.keys({
    ...metadata.dependencies,
    ...metadata.peerDependencies,
  }))
    await copyDependency(child, nextResolver);
}
await copyDependency("playwright");
dependencies.playwright = "1.63.0";
await copyDependency("@anthropic-ai/claude-agent-sdk");
await copyDependency(
  `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`,
);
dependencies["@anthropic-ai/claude-agent-sdk"] = "0.3.270";
await writeFile(
  `${stage}/package.json`,
  JSON.stringify(
    {
      name: "ido-agent",
      productName: "IDO Agent",
      version: pkg.version,
      type: "module",
      main: "main.js",
      description: "IDO Agent desktop client",
      author: "IDO contributors",
      license: "UNLICENSED",
      dependencies,
    },
    null,
    2,
  ),
);
console.log(`Prepared IDO Agent for ${process.platform}/${process.arch}`);
