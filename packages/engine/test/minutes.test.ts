import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/adapters/sqlite/store.js";
import { ProjectTeam } from "../src/processing/projects/team.js";
import { MinutesDocument } from "../src/processing/minutes/document.js";
import type { Meeting } from "../src/domain/models.js";
async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ido-minutes-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const user = store.createUser("writer", "test-password-long", "member");
  const viewer = store.createUser("viewer", "test-password-long", "viewer");
  for (const [id, userId] of [
    ["writer", user.id],
    ["viewer", viewer.id],
  ]) {
    store.put("device", id, { id, userId, revoked: false });
    store.put("project-member", `p:${id}`, { projectId: "p", deviceId: id });
  }
  store.put("project", "p", { id: "p", name: "Project" });
  store.put("meeting", "m", {
    id: "m",
    projectId: "p",
    name: "Meeting",
    summary: "Original",
    messages: [
      {
        id: "one",
        authorId: user.id,
        text: "決定事項",
        at: 1,
        stage: "completed",
      },
    ],
  });
  const team = new ProjectTeam(store);
  const meeting = () => store.get<Meeting>("meeting", "m")!;
  const edit = (markdown: string, expectedRevision = 0) =>
    team.updateMinutes("writer", {
      projectId: "p",
      meetingId: "m",
      markdown,
      expectedRevision,
    });
  return { store, team, meeting, edit };
}
test("manual edits preserve exact Markdown, enforce membership/role and compare revisions", async (t) => {
  const { store, team, meeting, edit } = await fixture(t);
  edit("# 手動編集\n\n[Task](ido://projects/p/tasks/t)\n");
  assert.equal(meeting().summaryRevision, 1);
  assert.equal(meeting().summary.endsWith("\n"), true);
  assert.ok(meeting().summaryUpdatedAt);
  assert.throws(() => edit("stale"), /MINUTES_CONFLICT/);
  assert.throws(
    () =>
      team.updateMinutes("viewer", {
        projectId: "p",
        meetingId: "m",
        markdown: "bad",
        expectedRevision: 1,
      }),
    /PERMISSION_DENIED/,
  );
  assert.throws(
    () =>
      team.updateMinutes("writer", {
        projectId: "other",
        meetingId: "m",
        markdown: "bad",
        expectedRevision: 1,
      }),
    /PROJECT_INVITATION_REQUIRED/,
  );
  assert.throws(() => edit("x".repeat(100001), 1), /INVALID_MINUTES/);
  edit("", 1);
  assert.equal(meeting().summary, "");
  assert.equal(team.snapshot("viewer", "p").canEditMinutes, false);
  store.remove("project-member", "p:writer");
  assert.throws(() => edit("bad", 2), /PROJECT_INVITATION_REQUIRED/);
});
test("generation retries from a concurrent manual edit and never creates a task", async (t) => {
  const { store, meeting, edit } = await fixture(t);
  let release!: (text: string) => void;
  const inputs: string[] = [];
  const document = new MinutesDocument(store, async (m) => {
    inputs.push(m.summary);
    if (inputs.length === 1)
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    return m.summary + "\n\n- 新しい決定";
  });
  const pending = document.refresh("m");
  edit("# 手動編集\n[別のタスク](ido://projects/other/tasks/real)");
  release("stale generation");
  await pending;
  assert.deepEqual(inputs, [
    "Original",
    "# 手動編集\n[別のタスク](ido://projects/other/tasks/real)",
  ]);
  assert.match(meeting().summary, /手動編集/);
  assert.match(meeting().summary, /ido:\/\/projects\/other\/tasks\/real/);
  assert.equal(meeting().summaryRevision, 2);
  assert.equal(store.list("task").length, 0);
  await document.refresh("m");
  assert.equal(inputs.length, 2);
});
test("new and revised speech during generation is not lost; existing tasks get real links", async (t) => {
  const { store, meeting } = await fixture(t);
  let release!: (text: string) => void;
  const calls: string[][] = [];
  const document = new MinutesDocument(store, async (m, links) => {
    calls.push(m.messages.map((message) => message.text));
    if (calls.length === 1)
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    return `${m.summary}\n${m.messages.map((message) => message.text).join("\n")}\n${links.join("\n")}`;
  });
  const pending = document.refresh("m");
  const changed = meeting();
  changed.messages[0].text = "訂正済みの発言";
  changed.messages.push({
    id: "two",
    authorId: "writer",
    text: "次の発言",
    at: 2,
    stage: "completed",
  });
  store.put("meeting", "m", changed);
  store.put("task", "real", {
    id: "real",
    projectId: "p",
    meetingId: "m",
    title: "実在タスク",
    text: "実装",
  });
  release("# 初稿");
  await pending;
  assert.deepEqual(calls[1], ["訂正済みの発言", "次の発言"]);
  assert.match(meeting().summary, /ido:\/\/projects\/p\/tasks\/real/);
  assert.equal(store.list("task").length, 1);
});
test("failure preserves the saved text and rejects hallucinated links; the next update recovers", async (t) => {
  const { store, meeting } = await fixture(t);
  let fail = true;
  const document = new MinutesDocument(store, async () =>
    fail ? "[fake](ido://projects/p/tasks/missing)" : "# 復旧",
  );
  await document.refresh("m");
  assert.equal(meeting().summary, "Original");
  assert.equal(meeting().summaryState, "failed");
  fail = false;
  await document.refresh("m");
  assert.equal(meeting().summary, "# 復旧");
  assert.equal(meeting().summaryState, "ready");
});
test("reset and shutdown fence an in-flight generation", async (t) => {
  const { store, meeting } = await fixture(t);
  let release!: (text: string) => void;
  const document = new MinutesDocument(
    store,
    () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
  );
  const pending = document.refresh("m");
  store.put("project-context", "p", { revision: 1 });
  release("outdated");
  await pending;
  assert.equal(meeting().summary, "Original");
  const second = document.refresh("m");
  document.stop();
  release("late");
  await second;
  assert.equal(meeting().summary, "Original");
});

test("topic updates and Markdown edits coexist during generation and context search reads the latest document", async (t) => {
  const { store, meeting, edit } = await fixture(t);
  const { MeetingKnowledgeStore } =
    await import("../src/processing/minutes/knowledge.js");
  const knowledge = new MeetingKnowledgeStore(store);
  let release!: (text: string) => void;
  let calls = 0;
  const document = new MinutesDocument(store, async (m) => {
    if (++calls === 1)
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    return m.summary + "\n\n自動追記";
  });
  const pending = document.refresh("m");
  edit(
    "# 手動編集\n\n[参照](ido://projects/p/tasks/t)\n" + "本文".repeat(2300),
  );
  const revision = meeting().summaryRevision;
  assert.equal(
    knowledge.apply(
      "p",
      {
        meetingId: "m",
        topics: [
          {
            id: null,
            title: "議題",
            summary: "決定事項の整理",
            decisions: ["決定事項"],
            openQuestions: [],
            sourceIds: ["one"],
          },
        ],
      },
      new Set(["one"]),
    ),
    true,
  );
  assert.equal(meeting().summaryRevision, revision);
  assert.match(meeting().summary, /^# 手動編集/);
  release("obsolete generation");
  await pending;
  assert.equal(calls, 2);
  assert.equal(meeting().summaryRevision, 2);
  assert.equal(meeting().knowledge!.topics.length, 1);
  const result = knowledge.search("p", { query: "手動編集" });
  assert.equal(result.documents!.length, 1);
  assert.equal(result.documents![0].revision, 2);
  assert.match(result.documents![0].markdown, /ido:\/\/projects\/p\/tasks\/t/);
  assert.equal(result.documents![0].nextOffset, 4000);
  const tail = knowledge.search("p", {
    meetingId: "m",
    documentOffset: result.documents![0].nextOffset,
  });
  assert.equal(
    result.documents![0].markdown + tail.documents![0].markdown,
    meeting().summary,
  );
  assert.throws(
    () => knowledge.search("p", { documentOffset: 4000 }),
    /INVALID_KNOWLEDGE_QUERY/,
  );
  edit("", 2);
  assert.deepEqual(knowledge.search("p", {}).documents, []);
  assert.equal(meeting().knowledge!.topics.length, 1);
});

test("silent results, failures and interrupted output are chunked into minutes and not repeated after restart", async (t) => {
  const { store, meeting } = await fixture(t);
  const text = "前".repeat(3999) + "😀" + "後".repeat(19000);
  for (const [id, state, result] of [
    ["silent", "completed", text],
    ["failed", "failed", "途中の成果と未確認事項"],
    ["cancelled", "cancelled", "停止前の成果"],
    ["interrupted", "interrupted", "再確認が必要"],
  ]) {
    store.put("task", id, {
      id,
      projectId: "p",
      meetingId: "m",
      title: id,
      text: id,
      runId: `run-${id}`,
      revision: 1,
      state,
      result,
      history: [],
    });
  }
  const received: import("@ido/common/contracts/work").MinutesTaskResult[] = [];
  const generate = async (
    m: Meeting,
    _links: string[],
    parts: import("@ido/common/contracts/work").MinutesTaskResult[],
  ) => {
    assert.ok(parts.length <= 4);
    assert.ok(parts.every((p) => p.text.length <= 4000));
    received.push(...parts);
    return (
      m.summary +
      "\n" +
      parts.map((p) => `${p.link} ${p.state} ${p.text}`).join("\n")
    );
  };
  await new MinutesDocument(store, generate).refresh("m");
  assert.equal(
    received
      .filter((p) => p.taskId === "silent")
      .map((p) => p.text)
      .join(""),
    text,
  );
  assert.ok(
    received.every((p) => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u.test(p.text)),
  );
  assert.match(meeting().summary, /途中の成果と未確認事項/);
  assert.match(meeting().summary, /停止前の成果/);
  const count = received.length;
  await new MinutesDocument(store, generate).refresh("m");
  assert.equal(received.length, count);
  assert.equal(store.list("task").length, 4);
});

test("result updates and manual edits during generation are reconciled before committing progress", async (t) => {
  const { store, meeting, edit } = await fixture(t);
  const task = {
    id: "result",
    projectId: "p",
    meetingId: "m",
    title: "Result",
    text: "Result",
    runId: "run",
    revision: 1,
    state: "failed",
    result: "old partial",
    history: [],
  };
  store.put("task", task.id, task);
  let release!: (value: string) => void;
  const calls: string[] = [];
  const document = new MinutesDocument(store, async (m, _links, parts) => {
    calls.push(parts.map((p) => p.text).join(""));
    if (calls.length === 1)
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    return m.summary + "\n" + parts.map((p) => p.text).join("\n");
  });
  const pending = document.refresh("m");
  edit("# 手で整理した議題");
  store.put("task", task.id, { ...task, result: "new partial" });
  release("stale");
  await pending;
  assert.deepEqual(calls, ["old partial", "new partial"]);
  assert.match(meeting().summary, /手で整理した議題/);
  assert.match(meeting().summary, /new partial/);
  await document.refresh("m");
  assert.equal(calls.length, 2);
});

test("a retry retains failed partial output and its explanation without reflecting the old version twice", async (t) => {
  const { store } = await fixture(t);
  const first = {
    id: "retry",
    projectId: "p",
    meetingId: "m",
    title: "Retry",
    text: "Retry",
    runId: "run",
    revision: 1,
    state: "failed",
    result: "検証済みの部分",
    progress: "接続できず残りは未確認",
    history: [],
  };
  store.put("task", first.id, first);
  const seen: string[] = [];
  const generate = async (
    m: Meeting,
    _links: string[],
    parts: import("@ido/common/contracts/work").MinutesTaskResult[],
  ) => {
    seen.push(...parts.map((p) => p.text));
    return m.summary + "\n" + parts.map((p) => p.text).join("\n");
  };
  await new MinutesDocument(store, generate).refresh("m");
  assert.deepEqual(seen, ["接続できず残りは未確認\n検証済みの部分"]);
  store.put("task", first.id, {
    ...first,
    revision: 2,
    state: "completed",
    result: "再確認完了",
    progress: undefined,
    history: [
      {
        revision: 1,
        runId: "run",
        state: first.state,
        result: first.result,
        progress: first.progress,
        text: first.text,
      },
    ],
  });
  await new MinutesDocument(store, generate).refresh("m");
  assert.deepEqual(seen, [
    "接続できず残りは未確認\n検証済みの部分",
    "再確認完了",
  ]);
});

test("task context links pending work to its sources and reconciles task-only changes during generation", async (t) => {
  const { store, meeting } = await fixture(t);
  const task = {
    id: "research",
    projectId: "p",
    meetingId: "m",
    title: "方式比較",
    text: "候補を比較する",
    state: "queued",
    sourceIds: ["one"],
    runId: "run",
    revision: 1,
    history: [],
  };
  store.put("task", task.id, task);
  store.put("task", "unrelated", {
    ...task,
    id: "unrelated",
    meetingId: "other",
  });
  let release!: (text: string) => void;
  const seen: import("@ido/common/contracts/work").MinutesTaskContext[][] = [];
  const document = new MinutesDocument(
    store,
    async (_m, _links, results, tasks) => {
      seen.push(tasks);
      assert.equal(results.length, 0, "pending work has no verified results");
      if (seen.length === 1)
        return new Promise<string>((resolve) => {
          release = resolve;
        });
      return `## ${tasks[0].link}\n\n- ${tasks[0].text}（${tasks[0].state}、関連: ${tasks[0].link}）`;
    },
  );
  const pending = document.refresh("m");
  store.put("task", task.id, {
    ...task,
    text: "候補AとBを比較する",
    state: "running",
  });
  release("outdated task context");
  await pending;
  assert.equal(seen.length, 2);
  assert.equal(seen[0].length, 1);
  assert.deepEqual(seen[0][0].sourceIds, ["one"]);
  assert.equal(seen[0][0].state, "queued");
  assert.equal(seen[1][0].state, "running");
  assert.match(meeting().summary, /候補AとB/);
  assert.equal(
    meeting().summaryRevision,
    1,
    "stale task context is never committed",
  );
  await document.refresh("m");
  assert.equal(seen.length, 2);
  store.put("task", task.id, { ...task, text: "候補Cも比較する", revision: 2 });
  await document.refresh("m");
  assert.equal(
    seen.length,
    3,
    "task-only edits trigger generation without new speech",
  );
  assert.match(meeting().summary, /候補C/);
});

test("conversation passes task provenance to the Markdown model with topic associations and inline citation rules", async (t) => {
  const { store, meeting } = await fixture(t);
  const { OpenAIModels } = await import("../src/adapters/openai/models.js");
  const { Conversation } = await import("../src/processing/conversation.js");
  const { MeetingKnowledgeStore } =
    await import("../src/processing/minutes/knowledge.js");
  new MeetingKnowledgeStore(store).apply(
    "p",
    {
      meetingId: "m",
      topics: [
        {
          id: null,
          title: "方式",
          summary: "方式を比較中",
          decisions: [],
          openQuestions: ["採用方式は未決"],
          sourceIds: ["one"],
        },
      ],
    },
    new Set(["one"]),
  );
  store.put("task", "compare", {
    id: "compare",
    projectId: "p",
    meetingId: "m",
    title: "方式比較",
    text: "方式AとBを比較",
    sourceIds: ["one"],
    state: "queued",
    runId: "run",
    revision: 1,
  });
  const model = new OpenAIModels({ get: async () => undefined });
  let calls = 0;
  t.mock.method(
    model,
    "api",
    async () =>
      ({
        responses: {
          create: async (request: {
            input: string;
            instructions: string;
            tools: unknown[];
          }) => {
            calls++;
            const input = JSON.parse(request.input);
            assert.deepEqual(input.groundedTopics[0].relatedTaskIds, [
              "compare",
            ]);
            assert.deepEqual(input.tasks[0].sourceIds, ["one"]);
            assert.equal(input.tasks[0].state, "queued");
            assert.equal(input.tasks[0].text, "方式AとBを比較");
            assert.deepEqual(input.taskResults, []);
            assert.deepEqual(request.tools, []);
            assert.match(request.instructions, /タスクとの紐付けを最優先/);
            assert.match(
              request.instructions,
              /各記述のすぐそばに関連するタスクリンク/,
            );
            assert.match(
              request.instructions,
              /依頼内容は成果の証明ではありません/,
            );
            return {
              status: "completed",
              output_text: `## ${input.tasks[0].link}\n\n- 採用方式は未決（関連: ${input.tasks[0].link}）`,
            };
          },
        },
      }) as never,
  );
  await new Conversation(store, model).document.refresh("m");
  assert.equal(calls, 1);
  assert.equal(meeting().summaryState, "ready");
  assert.equal(
    meeting().summary.match(/ido:\/\/projects\/p\/tasks\/compare/g)?.length,
    2,
  );
});
