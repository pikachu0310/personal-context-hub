import { mkdir, cp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
const argument = process.argv[2];
if (!argument)
  throw new Error(
    "Usage: npm run studio:demo:init -- /absolute/path/to/new-demo-directory",
  );
const directory = resolve(argument);
await mkdir(directory, { recursive: false, mode: 0o700 });
const project = join(directory, "exhibition");
await cp(
  fileURLToPath(new URL("../fixtures/studio-exhibition", import.meta.url)),
  project,
  { recursive: true, errorOnExist: true },
);
await exec("git", ["init", "-q", project]);
await exec("git", [
  "-C",
  project,
  "add",
  "AGENTS.md",
  "server.mjs",
  "index.html",
  "booths.json",
]);
await exec("git", [
  "-C",
  project,
  "-c",
  "user.name=Studio Demo",
  "-c",
  "user.email=studio@example.invalid",
  "commit",
  "-qm",
  "Seed fictional exhibition demo",
]);
const config = {
  port: 4311,
  host: "127.0.0.1",
  stateDirectory: join(directory, "state"),
  ...(process.env.PERSONAL_CONTEXT_VOICE_CODEX_HOME
    ? { codexHome: process.env.PERSONAL_CONTEXT_VOICE_CODEX_HOME }
    : {}),
  projects: [
    {
      id: "exhibition",
      name: "展示をみんなでつくる",
      description: "来場者がスマートフォンで使う展示案内",
      directory: project,
      previewCommand: [process.execPath, "server.mjs", "{port}"],
      previewChecks: [
        {
          role: "button",
          name: "いま体験できる",
          minWidth: 120,
          minHeight: 44,
          action: "click",
          expectText: "体験できる展示",
        },
      ],
    },
  ],
};
await writeFile(
  join(directory, "studio.config.json"),
  JSON.stringify(config, null, 2),
  { mode: 0o600, flag: "wx" },
);
console.log(`Demo project and local configuration created in ${directory}`);
console.log(
  "Set IDD_STUDIO_CONFIG to studio.config.json, then run npm run start:studio.",
);
