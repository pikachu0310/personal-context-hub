import {
  mkdir,
  readFile,
  writeFile,
  rm,
  lstat,
  realpath,
} from "node:fs/promises";
import { dirname, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAgentClientFiles } from "../src/discord-agent-download.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, ".desktop-build/app");
// Clear only the verified staging directory. Reject redirected/junction parents.
const staging = dirname(output);
await mkdir(staging, { recursive: true });
if (
  (await realpath(staging)) !== resolve(await realpath(root), ".desktop-build")
)
  throw new Error("Desktop staging directory must be inside this checkout.");
try {
  if ((await lstat(output)).isSymbolicLink())
    throw new Error("Refusing linked staging directory.");
  await rm(output, { recursive: true, force: true });
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const files = (await collectAgentClientFiles(root)).filter(
  ([name]) =>
    name.startsWith("src/") || name === "scripts/agent-worker-dpapi.ps1",
);
for (const name of [
  "main.mjs",
  "security.mjs",
  "local-tasks.mjs",
  "preload.cjs",
  "icon.ico",
  "discord-agent-ui.html",
  "discord-agent-ui-client.js",
])
  files.push([
    `desktop/${name}`,
    await readFile(resolve(root, "desktop", name)),
  ]);
const lock = JSON.parse(
  await readFile(resolve(root, "package-lock.json"), "utf8"),
);
const dependencies = Object.fromEntries(
  ["@openai/codex-sdk", "ws"].map((name) => [
    name,
    lock.packages[`node_modules/${name}`].version,
  ]),
);
const manifest = {
  name: "ido-agent",
  version: "0.2.1",
  description: "Local agent workspace for Discord",
  author: "IDO Agent contributors",
  private: true,
  type: "module",
  main: "desktop/main.mjs",
  dependencies,
};
files.push([
  "package.json",
  Buffer.from(JSON.stringify(manifest, null, 2) + "\n"),
]);
for (const [name, bytes] of files) {
  const target = resolve(output, name);
  const child = relative(output, target);
  if (child.startsWith("..") || isAbsolute(child))
    throw new Error("Invalid bundle path");
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
}
console.log(
  `Prepared ${files.length} client files; no Bot configuration or credentials included.`,
);
