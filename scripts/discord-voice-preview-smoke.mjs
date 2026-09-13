import { mkdtemp, mkdir, copyFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskPreviewManager } from "../src/discord-voice-preview.mjs";
import { browserPreviewVerifier } from "../src/discord-voice-preview-browser.mjs";

const root = await mkdtemp(join(tmpdir(), "idd-preview-smoke-"));
const workspace = join(root, "demo");
await mkdir(workspace);
for (const file of ["server.mjs", "ui.json"])
  await copyFile(
    new URL(`../fixtures/idd-preview/${file}`, import.meta.url),
    join(workspace, file),
  );
const task = {
  id: "demo",
  workingDirectory: workspace,
  runRevision: 1,
  activeSpecRevision: 1,
  specRevision: 1,
};
const manager = new TaskPreviewManager({
  command: [process.execPath, "server.mjs", "{port}"],
  workspaceRoot: root,
  codexExecutable:
    process.env.PERSONAL_CONTEXT_VOICE_CODEX_EXECUTABLE ?? "codex",
  codexHome: process.env.PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME,
  verify: browserPreviewVerifier(
    [
      {
        role: "button",
        name: "試す",
        action: "click",
        expectText: "操作 1 回",
        minWidth: 80,
        minHeight: 40,
      },
    ],
    {
      executablePath:
        process.env.PERSONAL_CONTEXT_VOICE_PREVIEW_BROWSER_EXECUTABLE,
    },
  ),
});
try {
  const first = await manager.start(task);
  if (!first?.browserVerified)
    throw new Error(
      `First preview failed: ${first?.state}, ${first?.verification}`,
    );
  const oldUrl = first.url;
  await manager.stop(task.id, "superseded");
  await writeFile(
    join(workspace, "ui.json"),
    JSON.stringify({ width: 120, height: 48 }),
  );
  Object.assign(task, {
    runRevision: 2,
    activeSpecRevision: 2,
    specRevision: 2,
  });
  const second = await manager.start(task);
  if (!second?.browserVerified)
    throw new Error(
      `Second preview failed: ${second?.state}, ${second?.verification}`,
    );
  let oldStopped = false;
  try {
    await fetch(oldUrl, { signal: AbortSignal.timeout(1000) });
  } catch {
    oldStopped = true;
  }
  if (!oldStopped) throw new Error("Old preview is still reachable");
  console.log(
    JSON.stringify({
      firstRevision: first.runRevision,
      secondRevision: second.runRevision,
      browserOperationsPassed: 2,
      oldPreviewStopped: oldStopped,
      humanParticipantsTested: 0,
      scope:
        "local preview infrastructure, without Discord or Codex generation",
    }),
  );
} finally {
  await manager.close();
  await rm(root, { recursive: true, force: true });
}
