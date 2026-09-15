// Real audio API -> coordinator -> Engine WS -> Client -> Codex -> browser.
// Synthetic conversation, isolated storage, no Discord posts or microphone use.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import OpenAI from "openai";
import { chromium } from "playwright";
import { Engine } from "../packages/engine/src/bootstrap/engine.ts";
import { Client } from "../packages/client/src/bootstrap/client.ts";
import { createOpenAICoordinatorFactory } from "../packages/engine/src/adapters/openai/coordinator.ts";
import { renderPublication } from "../packages/plugin-discord/src/output/render.ts";

if (
  process.env.IDO_LIVE_EVAL !== "1" ||
  !process.env.OPENAI_API_KEY ||
  !process.env.IDO_EVAL_AUTH_FILE
)
  throw new Error(
    "Explicit live evaluation, API key and an existing Codex auth file are required.",
  );
const root = await mkdtemp(join(tmpdir(), "ido-meeting-loop-"));
const repository = join(root, "repository"),
  clientDirectory = join(root, "client");
await mkdir(repository);
await mkdir(join(clientDirectory, "codex"), { recursive: true, mode: 0o700 });
await symlink(
  process.env.IDO_EVAL_AUTH_FILE,
  join(clientDirectory, "codex", "auth.json"),
);
await writeFile(
  join(clientDirectory, "codex", "config.toml"),
  'cli_auth_credentials_store = "file"\n',
  { mode: 0o600 },
);
await writeFile(
  join(repository, "AGENTS.md"),
  "This is an isolated meeting integration fixture. Only create/edit index.html: a plain self-contained HTML page with a button labeled 試す, a visible counter initially 操作 0 回, and each click increments it. Read the meeting tools before writing and use the current agreed English CSS background color on that button. No agents, commits, tests, dependencies, external assets or network access. The user authorized this local mock.\n",
);
execFileSync("git", ["init", "-q", repository]);
execFileSync("git", ["-C", repository, "add", "AGENTS.md"]);
execFileSync("git", [
  "-C",
  repository,
  "-c",
  "user.name=Meeting Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "commit",
  "-qm",
  "fixture",
]);
const api = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
let requests = 0;
const factory = createOpenAICoordinatorFactory(
  { credentials: { get: async () => process.env.OPENAI_API_KEY } },
  {
    createClient: () => ({
      responses: {
        create: async (...args) => {
          if (++requests > 10)
            throw new Error("EVALUATION_REQUEST_BUDGET_EXCEEDED");
          return api.responses.create(...args);
        },
      },
    }),
  },
);
const engine = new Engine({
  directory: join(root, "engine"),
  port: 0,
  previewPort: 0,
  conversation: { coordinator: factory, observationIntervalMs: 60_000 },
  speech: { transcriptionModel: process.env.IDO_EVAL_TRANSCRIPTION_MODEL },
});
engine.credentials.get = async (name) =>
  name === "openai" ? process.env.OPENAI_API_KEY : undefined;
const client = new Client(clientDirectory);
client.credentials.backend = "file";
const outputs = [],
  publications = [],
  calls = [],
  report = {};
engine.plugins.publish = (event) => {
  if (event.type === "minutes") publications.push(renderPublication(event));
};
const until = async (check, stage, timeout = 150_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`TIMEOUT:${stage}`);
};
const input = (actor, event) =>
  engine.input.handle(
    {
      projectId: "project",
      meetingId: "meeting",
      eventId: crypto.randomUUID(),
      priority: "normal",
      ...event,
    },
    {
      pluginId: "loop-evaluation",
      actor: engine.store.conversationAuthor(actor),
      valid: () => true,
      deliver: async (output) => {
        outputs.push({ kind: output.kind, content: output.content });
      },
      publish: () => {},
    },
  );
let browser;
try {
  const user = engine.store.createUser(
    "fixture",
    "fixture-local-password",
    "member",
  );
  engine.store.put("project", "project", {
    id: "project",
    name: "音声から試作する会議",
    remote: "",
  });
  engine.store.put("meeting", "meeting", {
    id: "meeting",
    projectId: "project",
    name: "検証用会議",
    summary: "",
    messages: [],
  });
  for (const id of ["a", "b"])
    engine.store.put("participant", id, {
      id,
      name: `参加者${id.toUpperCase()}`,
      role: "member",
    });
  await engine.listen();
  await client.start(0);
  await client.checkAccount();
  assert.equal(client.loginStatus, "authenticated");
  engine.store.put("device", "device", {
    id: "device",
    userId: user.id,
    name: "評価用Client",
    publicKey: client.settings.publicKey,
    revoked: false,
    generation: 0,
    slots: 1,
    lastAssigned: 0,
    grants: [],
  });
  engine.store.put("project-member", "project:device", {
    projectId: "project",
    deviceId: "device",
  });
  client.settings.deviceId = "device";
  client.settings.engineUrl = engine.origin;
  client.settings.mappings = [
    { projectId: "project", directory: repository, slots: 1, network: false },
  ];
  client.allowedProjects.add("project");
  const retrieve = client.executor.knowledge;
  client.executor.knowledge = async (task, query) => {
    const result = await retrieve(task, query);
    calls.push({
      revision: task.revision,
      query,
      returned: result.messages.length,
    });
    return result;
  };
  await client.connect();
  await until(
    () => engine.ready.size === 1 && client.workspaceSupported,
    "connect",
    15000,
  );
  await input("a", {
    text: "ボタンの文字は「試す」。最初のボタンの色はgreenと決定する。クリックした回数をその場で表示したい。",
  });
  const spoken =
    "井戸ボット、今話したボタンのモックを作ってくれるかな。押すたびに回数が増える簡単なボタンにしてください。";
  const audio = await api.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: "alloy",
    input: spoken,
    response_format: "wav",
  });
  const started = Date.now();
  await input("b", {
    audio: Buffer.from(await audio.arrayBuffer()).toString("base64"),
  });
  await engine.conversation.coordinated.flush("meeting");
  engine.flush();
  await until(
    () =>
      engine.store
        .list("task")
        .some((task) =>
          ["completed", "failed", "interrupted"].includes(task.state),
        ),
    "first-task",
  );
  const task = engine.store.list("task")[0];
  assert.equal(task.state, "completed", task.progress);
  const run = client.executor.runs[task.runId],
    threadId = run.threadId;
  report.firstCompletedMs = Date.now() - started;
  report.transcription = engine.store
    .list("message")
    .find((message) => message.origin === "audio")?.text;
  assert.ok(report.transcription?.length);
  assert.ok(calls.length > 0);
  assert.ok(engine.store.get("meeting", "meeting").knowledge?.topics.length);
  assert.ok(
    outputs.some(
      (output) => output.kind === "reply" && /受け付け/u.test(output.content),
    ),
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.IDO_BROWSER_EXECUTABLE,
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 680 } });
  await page.goto(pathToFileURL(join(run.directory, "index.html")).href);
  const button = page.getByRole("button", { name: "試す", exact: true });
  assert.equal(
    await button.evaluate(
      (element) => globalThis.getComputedStyle(element).backgroundColor,
    ),
    "rgb(0, 128, 0)",
  );
  await button.click();
  await page.getByText(/操作\s*1\s*回/u).waitFor();
  console.log(
    JSON.stringify({
      stage: "audio-to-mock",
      ...report,
      model: run.model,
      contextCalls: calls.length,
    }),
  );
  await input("b", {
    text: "訂正。ボタンの色はblueへ変更することで決定する。greenは取り下げる。",
  });
  await engine.conversation.coordinated.flush("meeting");
  await input("b", { text: "そのモックを青にして" });
  engine.flush();
  await until(() => {
    const current = engine.store.get("task", task.id);
    return (
      current.revision === 2 &&
      ["completed", "failed", "interrupted"].includes(current.state)
    );
  }, "continuation");
  assert.equal(engine.store.list("task").length, 1);
  assert.equal(engine.store.get("task", task.id).state, "completed");
  assert.equal(client.executor.runs[task.runId].threadId, threadId);
  await page.reload();
  assert.equal(
    await button.evaluate(
      (element) => globalThis.getComputedStyle(element).backgroundColor,
    ),
    "rgb(0, 0, 255)",
  );
  await button.click();
  await page.getByText(/操作\s*1\s*回/u).waitFor();
  await mkdir(".ido-build/screenshots", { recursive: true });
  await page.screenshot({
    path: ".ido-build/screenshots/meeting-generated-mock.png",
  });
  Object.assign(report, {
    sameTaskContinuation: true,
    sameCodexThread: true,
    contextCalls: calls.length,
    coordinatorRequests: requests,
    automaticMinutes: true,
    publications: publications.at(-1),
    replies: outputs.filter((output) => output.kind === "reply"),
  });
  console.log(
    JSON.stringify({
      stage: "teammate-followup",
      sameTask: true,
      sameThread: true,
      color: "blue",
      contextCalls: calls.length,
    }),
  );
} finally {
  report.finalState = {
    messages: engine.store
      .list("message")
      .map(({ text, origin, stage }) => ({ text, origin, stage })),
    tasks: engine.store
      .list("task")
      .map(({ id, state, progress, revision }) => ({
        id,
        state,
        progress,
        revision,
      })),
    outputs,
    coordinatorRequests: requests,
  };
  console.log(JSON.stringify({ stage: "final-state", ...report.finalState }));
  await browser?.close();
  await client.close();
  await engine.close();
  await factory.close();
  await mkdir(".ido-build/meeting-evaluation", { recursive: true });
  await writeFile(
    resolve(".ido-build/meeting-evaluation/loop.json"),
    JSON.stringify(report, null, 2),
  );
  await rm(root, { recursive: true, force: true });
}
