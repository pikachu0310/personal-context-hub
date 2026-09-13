import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  copyFile,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexVoiceRunner } from "../src/execution/codex/runner.mjs";
import { DiscordVoiceTaskQueue } from "../src/adapters/discord/sessions.mjs";
import { TaskPreviewManager } from "../src/execution/preview.mjs";
import { browserPreviewVerifier } from "../src/execution/preview-browser.mjs";

const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "idd-loop-smoke-"));
const repository = join(root, "source");
await mkdir(repository);
for (const file of ["server.mjs", "ui.json"])
  await copyFile(
    new URL(`../fixtures/idd-preview/${file}`, import.meta.url),
    join(repository, file),
  );
await writeFile(
  join(repository, "AGENTS.md"),
  "This is a bounded integration fixture. Change only ui.json as requested. Do not create agents, call external services, commit, or change unrelated files. Validate the JSON after editing.\n",
);
await exec("git", ["init", "-q", repository]);
await exec("git", ["-C", repository, "add", "."]);
await exec("git", [
  "-C",
  repository,
  "-c",
  "user.name=IDD Smoke",
  "-c",
  "user.email=idd-smoke@example.invalid",
  "commit",
  "-qm",
  "fixture",
]);
const runner = new CodexVoiceRunner({
  workingDirectory: repository,
  taskWorkspaceDirectory: join(root, "workspaces"),
  isolatedCodexHome: join(root, "codex-home"),
  codexExecutable:
    process.env.PERSONAL_CONTEXT_VOICE_CODEX_EXECUTABLE ?? "codex",
  codexTransport: "app-server",
  powerMode: true,
  codexHome: process.env.PERSONAL_CONTEXT_VOICE_CODEX_HOME,
  taskModel: "gpt-5.6-sol",
  taskReasoningEffort: "low",
  complexTaskModel: "gpt-5.6-sol",
  complexTaskReasoningEffort: "low",
});
let expectedWidth = 160;
const previews = new TaskPreviewManager({
  command: [process.execPath, "server.mjs", "{port}"],
  workspaceRoot: join(root, "workspaces"),
  codexExecutable: runner.config.codexExecutable,
  codexHome: runner.config.isolatedCodexHome,
  verify: (options) =>
    browserPreviewVerifier(
      [
        {
          role: "button",
          name: "試す",
          minWidth: expectedWidth,
          minHeight: 48,
          action: "click",
          expectText: "操作 1 回",
        },
      ],
      {
        executablePath:
          process.env.PERSONAL_CONTEXT_VOICE_PREVIEW_BROWSER_EXECUTABLE,
      },
    )(options),
});
const queue = new DiscordVoiceTaskQueue({
  logger: {},
  postText: async () => {},
  createTaskThread: async () => ({
    post: async () => {},
    update: async () => {},
  }),
  runTask: async (task, options) => {
    await previews.stop(task.id, "superseded");
    let result;
    try {
      result = await runner.runTask(task, options);
    } catch (error) {
      console.error(error.publicMessage ?? error.message);
      throw error;
    }
    await previews.start(task, options);
    return result;
  },
  steerTask: (task, text) => runner.steerTask(task, text),
  invalidatePreview: (task) => previews.stop(task.id, "superseded"),
});
const waitForRevision = async (revision) => {
  const start = Date.now();
  while (Date.now() - start < 180_000) {
    const task = queue.tasks.get("demo");
    if (task.state === "failed") throw new Error("Codex fixture task failed");
    if (
      task.state === "completed" &&
      !task.executing &&
      task.runRevision === revision
    ) {
      if (!task.preview?.browserVerified)
        throw new Error(
          `Preview verification failed: ${task.preview?.verification}`,
        );
      return task;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Codex fixture task timed out");
};
const startedAt = Date.now();
try {
  await queue.enqueueDurable({
    id: "demo",
    title: "ボタンを大きくする",
    request:
      "ui.jsonだけを編集し、widthを160、heightを56にしてください。JSONを読み戻して検証し、短く結果を返してください。",
    kind: "implementation",
    specRevision: 1,
  });
  const first = await waitForRevision(1);
  const firstMs = Date.now() - startedAt;
  const originalThread = first.codexThreadId;
  const oldUrl = first.preview.url;
  const firstSize = JSON.parse(
    await readFile(join(first.workingDirectory, "ui.json"), "utf8"),
  );
  if (firstSize.width !== 160 || firstSize.height !== 56)
    throw new Error("First size is incorrect");
  console.log(
    JSON.stringify({
      stage: "first_preview",
      elapsedMs: firstMs,
      model: first.profile.model,
      reasoningEffort: first.profile.modelReasoningEffort,
      browserVerified: true,
    }),
  );
  expectedWidth = 120;
  await queue.handleTaskMessageDurable({
    taskId: "demo",
    userId: "fixture-user",
    ownerUserId: "fixture-user",
    requestKey: "fixture-correction",
    content:
      "大きすぎるので少し戻して。ui.jsonだけを編集し、widthを120、heightを48にしてください。JSONを読み戻して検証してください。",
  });
  const second = await waitForRevision(2);
  const size = JSON.parse(
    await readFile(join(second.workingDirectory, "ui.json"), "utf8"),
  );
  if (size.width !== 120 || size.height !== 48)
    throw new Error("Corrected size is incorrect");
  if (originalThread !== second.codexThreadId)
    throw new Error("Correction lost the Codex conversation");
  if (second.resultMetadata.specRevision !== 2)
    throw new Error("Correction lost the specification revision");
  let oldStopped = false;
  try {
    await fetch(oldUrl, { signal: AbortSignal.timeout(1000) });
  } catch {
    oldStopped = true;
  }
  if (!oldStopped) throw new Error("Superseded preview remains reachable");
  const report = {
    elapsedMs: Date.now() - startedAt,
    firstPreviewMs: firstMs,
    revisions: 2,
    sameCodexThread: true,
    browserOperationsPassed: 2,
    correctedSize: size,
    oldPreviewStopped: true,
    usage: second.usageHistory,
    humanParticipantsTested: 0,
    discordTested: false,
  };
  console.log(JSON.stringify(report));
  if (process.env.IDD_SMOKE_ARTIFACT_DIRECTORY) {
    const output = process.env.IDD_SMOKE_ARTIFACT_DIRECTORY;
    await mkdir(output, { recursive: true, mode: 0o700 });
    await writeFile(
      join(output, "loop-smoke.json"),
      JSON.stringify(report, null, 2),
      { mode: 0o600 },
    );
    if (second.preview.screenshotPath)
      await copyFile(
        second.preview.screenshotPath,
        join(output, "loop-preview.png"),
      );
  }
} finally {
  await queue.stop();
  await previews.close();
  await runner.close();
  await rm(root, { recursive: true, force: true });
}
