// Explicit opt-in: real Codex turns, synthetic meeting data, no Discord delivery.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Executor } from "../packages/client/src/execution/executor.ts";
import { Store } from "../packages/engine/src/adapters/sqlite/store.ts";
import { MeetingKnowledgeStore } from "../packages/engine/src/processing/minutes/knowledge.ts";

if (process.env.IDO_LIVE_EVAL !== "1" || !process.env.IDO_EVAL_AUTH_FILE)
  throw new Error(
    "Set IDO_LIVE_EVAL=1 and IDO_EVAL_AUTH_FILE to an existing Codex auth file.",
  );
const root = await mkdtemp(join(tmpdir(), "ido-meeting-codex-"));
const legacy = process.env.IDO_EVAL_LEGACY_CONTEXT === "1";
const repository = join(root, "repository"),
  home = join(root, "client", "codex");
await mkdir(repository);
await mkdir(home, { recursive: true, mode: 0o700 });
await symlink(process.env.IDO_EVAL_AUTH_FILE, join(home, "auth.json"));
await writeFile(
  join(home, "config.toml"),
  `cli_auth_credentials_store = "file"\n[projects.${JSON.stringify(repository)}]\ntrust_level = "trusted"\n`,
  { mode: 0o600 },
);
await writeFile(
  join(repository, "AGENTS.md"),
  `This is an isolated integration fixture. ${legacy ? "Read the latest meeting context supplied with each request to find the currently agreed color." : "Use meeting_context_search and meeting_context_read to retrieve the current agreed color."} Only write color.txt. Do not create agents, commit, run tests, use the network or modify other files.\n`,
);
execFileSync("git", ["init", "-q", repository]);
const store = new Store(join(root, "engine"));
const knowledge = new MeetingKnowledgeStore(store);
store.put("project", "project", {
  id: "project",
  name: "検証用会議",
  remote: "",
});
store.put("meeting", "meeting", {
  id: "meeting",
  projectId: "project",
  name: "色の検討",
  summary: "",
  messages: [],
});
const seed = (text, id) => {
  store.put("message", id, {
    id,
    meetingId: "meeting",
    authorId: id,
    authorName: `参加者${id}`,
    at: Date.now(),
    text,
    role: "user",
    stage: "completed",
    complete: true,
  });
  knowledge.apply(
    "project",
    {
      meetingId: "meeting",
      topics: [
        {
          id: store.get("meeting", "meeting").knowledge?.topics[0]?.id ?? null,
          title: "ボタンの色",
          summary: text,
          decisions: [text],
          openQuestions: [],
          sourceIds: [id],
        },
      ],
    },
    new Set([id]),
  );
};
seed("ボタンの色はgreenで決定。", "a");
const executor = new Executor(join(root, "client"), () => {});
await executor.load();
const calls = [];
let stopping = false;
executor.knowledge = async (task, input) => {
  calls.push({ round: stopping ? 3 : task.revision, input });
  if (stopping) {
    const active = executor.active.get(task.runId);
    active.abort.abort(new Error("EVAL_STOP"));
    throw new Error("EVAL_STOP");
  }
  return knowledge.search(task.projectId, input);
};
const value = {
  ...(legacy ? { meetingToolsEnabled: false, boardToolsEnabled: false } : {}),
  directory: repository,
  state: "assigned",
  task: {
    id: "task",
    runId: "run",
    revision: 1,
    specRevision: 1,
    projectId: "project",
    meetingId: "meeting",
    authorId: "a",
    text: "会議の議事録と元発言を両方読んで、現在合意されている英語の色名だけをcolor.txtに保存してください。",
    kind: "implementation",
    state: "assigned",
    network: false,
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
};
executor.runs.run = value;
const mapping = {
  projectId: "project",
  directory: repository,
  network: false,
  slots: 1,
};
const run = async () => {
  const timer = setTimeout(
    () => executor.active.get("run")?.abort.abort(new Error("EVAL_TIMEOUT")),
    120_000,
  );
  try {
    await executor.execute(value, mapping, false);
  } finally {
    clearTimeout(timer);
  }
};
try {
  await run();
  assert.equal(
    (await readFile(join(repository, "color.txt"), "utf8")).trim(),
    "green",
  );
  assert.ok(
    legacy
      ? calls.length === 1
      : calls.some((call) => call.input.sourceIds?.includes("a")),
  );
  const threadId = value.threadId,
    model = value.model;
  console.log(
    JSON.stringify({
      stage: "created",
      legacyContext: legacy,
      model,
      effort: value.reasoningEffort,
      contextCalls: calls.length,
    }),
  );
  seed("訂正。ボタンの色をblueへ変更することで決定。green案は取り下げ。", "b");
  value.task.revision = 2;
  value.task.specRevision = 2;
  value.task.text =
    "別の参加者から追加依頼です。最新の会議文脈と元発言を読み直し、同じcolor.txtを現在の合意へ更新してください。";
  await run();
  assert.equal(
    (await readFile(join(repository, "color.txt"), "utf8")).trim(),
    "blue",
  );
  assert.equal(value.threadId, threadId);
  assert.equal(value.model, model);
  assert.ok(
    calls.some(
      (call) =>
        call.round === 2 && (legacy || call.input.sourceIds?.includes("b")),
    ),
  );
  console.log(
    JSON.stringify({
      stage: "continued",
      sameThread: true,
      color: "blue",
      contextCalls: calls.length,
    }),
  );
  stopping = true;
  value.task.text =
    "最新の議事録を検索してからcolor.txtをredに変更してください。検索より先にファイルを編集しないでください。";
  await assert.rejects(run(), /EVAL_STOP|abort|interrupt/i);
  assert.ok(calls.some((call) => call.round === 3));
  assert.equal(
    (await readFile(join(repository, "color.txt"), "utf8")).trim(),
    "blue",
  );
  console.log(
    JSON.stringify({
      stage: "stopped",
      noPostStopWrite: true,
      contextCalls: calls.length,
    }),
  );
} finally {
  for (const active of executor.active.values()) {
    active.abort.abort();
    await active.codex.close();
  }
  store.db.close();
  assert.equal(root.startsWith(join(tmpdir(), "ido-meeting-codex-")), true);
  await rm(root, { recursive: true, force: true });
}
