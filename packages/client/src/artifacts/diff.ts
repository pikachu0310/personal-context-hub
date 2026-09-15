import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { run } from "@ido/common/runtime/platform";

import type { Executor } from "../execution/executor.js";
export async function artifact(this: Executor, runId: string) {
  const value = this.runs[runId];
  if (!value) throw new Error("RUN_NOT_FOUND");
  let patch = await run("git", [
    "-C",
    value.directory,
    "diff",
    "HEAD",
    "--",
    ".",
    ":(exclude).env*",
    ":(exclude)auth.json",
    ":(exclude)secrets*",
    ":(exclude)*.pem",
    ":(exclude)*.key",
    ":(exclude)**/.env*",
    ":(exclude)**/auth.json",
    ":(exclude)**/secrets*",
    ":(exclude)**/*.pem",
    ":(exclude)**/*.key",
  ]);
  const untracked = await run("git", [
    "-C",
    value.directory,
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const root = await realpath(value.directory);
  for (const path of untracked.split("\0").filter(Boolean).slice(0, 100)) {
    if (
      /(^|\/)(?:\.env[^/]*|auth\.json|secrets[^/]*|[^/]*\.(?:pem|key))$/i.test(
        path,
      )
    )
      continue;
    const target = await realpath(join(root, path));
    if (!target.startsWith(root + (process.platform === "win32" ? "\\" : "/")))
      continue;
    const contents = await readFile(target);
    if (contents.length > 256000 || contents.includes(0)) continue;
    const lines = contents.toString().split("\n");
    patch += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => "+" + line).join("\n")}\n`;
    if (patch.length > 900000) break;
  }
  return {
    patch: patch.slice(0, 256000),
    branch:
      value.workspaceMode === "project"
        ? await run("git", ["-C", value.directory, "branch", "--show-current"])
        : `ido/${runId}`,
    revision: value.task.revision,
  };
}
