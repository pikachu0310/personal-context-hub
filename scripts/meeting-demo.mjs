// Opt-in exhibition rehearsal: real speech API -> meeting -> Codex -> Client.
// Synthetic conversation and isolated storage. Never connects to Discord.
// Leaves the Client running to open the prototype and ask for changes.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import OpenAI from "openai";
import { Engine } from "../packages/engine/src/bootstrap/engine.ts";
import { Client } from "../packages/client/src/bootstrap/client.ts";
import { createOpenAICoordinatorFactory } from "../packages/engine/src/adapters/openai/coordinator.ts";

if (
  process.env.IDO_LIVE_EVAL !== "1" ||
  !process.env.OPENAI_API_KEY ||
  !process.env.IDO_EVAL_AUTH_FILE
)
  throw new Error(
    "Explicit live evaluation, API key and an existing Codex auth file are required.",
  );
const resume = process.env.IDO_DEMO_DIRECTORY;
await mkdir(resolve(".ido-build/demos"), { recursive: true, mode: 0o700 });
const root = resume
  ? resolve(resume)
  : await mkdtemp(resolve(".ido-build/demos/session-"));
const repository = join(root, "repository"),
  clientDirectory = join(root, "client");
if (!resume) {
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
    `This is an isolated exhibition prototype workspace. Use meeting_context_search/read before acting. Only create/edit index.html, a self-contained HTML app with inline CSS/JS and no external resources. No agents, commits, tests, dependencies, network or other files. Build a polished Japanese desktop/mobile interactive prototype comparing teleport versus smooth locomotion for VR game DESIGN, rendered as two side-by-side first-person scenes using a small inline Canvas raycaster (no third-party libraries). This is a browser comparison, not a validated VR headset experience. Palette: slate #172c43, ice #edf3f9, blue #1476ca for teleport, amber #db790b for smooth motion, white. Bold restrained Japanese title, generous usable canvas area, architectural obstacle course with gates, floor marks and an end beacon. Teleport should jump to successive positions; smooth motion should visibly animate between them. Provide visible native buttons named 前へ, 左へ, 右へ, 初期位置 within each labeled scene; a range input labeled 連続移動の速さ starts at 1. Show numeric current position in each scene and update it after movements. Initial forward action must move toward an accessible gate. Keyboard arrows control the focused scene and touch uses the buttons. Respect reduced motion for decorative elements; actual user-requested movement must still work. Header: 会議の続きを、動くもので。 Subheading: VRゲームの移動方式を、その場で比べる。 Small label: ブラウザ比較用の試作. Keep clear contrast, responsive layout and accessible labels. No fake live transcription, timers, AI generation animation or claims about unseen headset validation. The user authorized building this local prototype.`,
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
}
const api = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, maxRetries: 0 });
let requests = 0;
const requestLimit = Number(process.env.IDO_DEMO_REQUEST_LIMIT ?? 0);
if (!Number.isSafeInteger(requestLimit) || requestLimit < 0)
  throw new Error("INVALID_DEMO_REQUEST_LIMIT");
const factory = createOpenAICoordinatorFactory(
  { credentials: { get: async () => process.env.OPENAI_API_KEY } },
  {
    createClient: () => ({
      responses: {
        create: async (...args) => {
          if (requestLimit > 0 && ++requests > requestLimit)
            throw new Error("EVALUATION_REQUEST_BUDGET_EXCEEDED");
          return api.responses.create(...args);
        },
      },
    }),
  },
);
const engine = new Engine({
  directory: join(root, "engine"),
  port: Number(process.env.IDO_DEMO_ENGINE_PORT ?? 4340),
  previewPort: Number(process.env.IDO_DEMO_PREVIEW_PORT ?? 4341),
  uiDirectory: resolve("packages/engine/dist/ui"),
  dashboardEntry: resolve("packages/plugin-dashboard/dist/index.js"),
  conversation: { coordinator: factory, observationIntervalMs: 12_000 },
  speech: { transcriptionModel: process.env.IDO_EVAL_TRANSCRIPTION_MODEL },
});
engine.credentials.get = async (name) =>
  name === "openai" ? process.env.OPENAI_API_KEY : undefined;
const client = new Client(clientDirectory, resolve("packages/client/dist/ui"));
client.credentials.backend = "file";
const outputs = [],
  calls = [],
  report = {};
const until = async (check, stage, timeout = 360_000) => {
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
const stopped = new Promise((resolve) => {
  const stop = () => {
    for (const active of client.executor.active.values()) active.abort.abort();
    resolve();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
});
try {
  await engine.listen();
  await client.start(Number(process.env.IDO_DEMO_CLIENT_PORT ?? 4342));
  await client.checkAccount();
  assert.equal(client.loginStatus, "authenticated");
  if (!resume) {
    const user = engine.store.createUser(
      "fixture",
      "fixture-local-password",
      "member",
    );
    engine.store.put("project", "project", {
      id: "project",
      name: "展示リハーサル · VR移動方式",
      remote: "",
    });
    engine.store.put("meeting", "meeting", {
      id: "meeting",
      projectId: "project",
      name: "ワープ移動と連続移動の比較",
      summary: "",
      messages: [],
    });
    for (const id of ["a", "b"])
      engine.store.put("participant", id, {
        id,
        name: `参加者${id.toUpperCase()}`,
        role: "member",
      });
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
  }
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
    console.log(
      JSON.stringify({
        stage: "meeting-context-read",
        revision: task.revision,
        returned: result.messages.length,
        documents: result.documents?.length ?? 0,
      }),
    );
    return result;
  };
  await client.connect();
  await until(
    () => engine.ready.size === 1 && client.workspaceSupported,
    "connect",
    15000,
  );
  if (!resume) {
    await input("a", {
      text: "VRゲームの移動はワープと連続移動で迷っている。ブラウザで同じコースを並べて比較したい。連続移動の初期速度は1にして、あとで触りながら調整したい。VR機器での検証は別途必要。",
    });
    const audio = await api.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      response_format: "wav",
      input:
        "井戸ボット、今話した二つの移動方式を同じ画面で触って比べられるモックを作ってください。前や左右に動く操作も付けてください。",
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
      "prototype",
    );
    report.elapsedMs = Date.now() - started;
  }
  const task = engine.store.list("task")[0];
  assert.ok(task, "DEMO_TASK_NOT_FOUND");
  if (!resume) assert.equal(task.state, "completed", task.progress);
  const run = client.executor.runs[task.runId];
  await client.save();
  await client.executor.save();
  const result = {
    clientUrl: client.origin,
    exhibitUrl: `${client.origin}/?previewRun=${encodeURIComponent(task.runId)}&exhibit=1`,
    directory: root,
    artifact: join(run.directory, "index.html"),
    taskId: task.id,
    runId: task.runId,
    elapsedMs: report.elapsedMs,
    knowledgeCalls: calls.length,
  };
  await mkdir(".ido-build", { recursive: true });
  await writeFile(
    ".ido-build/meeting-demo-session.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify({ stage: "demo-ready", ...result }));
  await stopped;
} finally {
  await client.close();
  await engine.close();
  await factory.close();
  console.log(JSON.stringify({ stage: "demo-stopped", directory: root }));
}
