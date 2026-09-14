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
  external: ["electron", "ws", "@openai/codex"],
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
