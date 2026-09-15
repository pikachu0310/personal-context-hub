import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Store } from "../src/adapters/sqlite/store.js";
import { MeetingKnowledgeStore } from "../src/processing/minutes/knowledge.js";
import { parseCoordinatorResponse } from "../src/adapters/openai/coordinator-prompt.js";
import type { Meeting, Message } from "../src/domain/models.js";

test("topic minutes preserve source statements and corrections, survive restart, and stay within the project", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-knowledge-"));
  let store = new Store(directory);
  t.after(async () => {
    store.db.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const id of ["project", "other"])
    store.put("project", id, { id, name: id, remote: "" });
  for (const [id, projectId] of [
    ["meeting", "project"],
    ["other-meeting", "other"],
  ])
    store.put("meeting", id, {
      id,
      projectId,
      name: id,
      summary: "",
      messages: [],
    });
  const statements: Message[] = [
    {
      id: "a",
      meetingId: "meeting",
      authorId: "alice",
      authorName: "話者A",
      at: 1,
      text: "検索画面は一覧から絞り込む案にしたい。",
      stage: "completed",
      role: "user",
      complete: true,
    },
    {
      id: "b",
      meetingId: "meeting",
      authorId: "bob",
      authorName: "話者B",
      at: 2,
      text: "一覧からの絞り込みで決定。検索速度は測ってから決めよう。",
      stage: "completed",
      role: "user",
      complete: true,
    },
    {
      id: "c",
      meetingId: "meeting",
      authorId: "alice",
      authorName: "話者A",
      at: 3,
      text: "訂正。今日は検索速度の計測まではせず、明日の会議に回そう。",
      stage: "completed",
      role: "user",
      complete: true,
    },
    {
      id: "foreign",
      meetingId: "other-meeting",
      authorId: "alice",
      at: 4,
      text: "別プロジェクトの検索画面の秘密",
      stage: "completed",
      role: "user",
      complete: true,
    },
    {
      id: "bot",
      meetingId: "meeting",
      authorId: "bot",
      at: 5,
      text: "決定したことにしましょう",
      stage: "completed",
      role: "assistant",
      complete: true,
    },
    {
      id: "partial",
      meetingId: "meeting",
      authorId: "alice",
      at: 6,
      text: "まだ言い終わっていない",
      stage: "queued",
      role: "user",
      complete: false,
    },
  ];
  for (const statement of statements)
    store.put("message", statement.id, statement);
  const knowledge = new MeetingKnowledgeStore(store);
  const edited = store.get<Meeting>("meeting", "meeting")!;
  edited.summary =
    "# 人が編集した議事録\n検索速度の計測予算は担当者が確認する。";
  edited.summaryRevision = 7;
  edited.summaryUpdatedAt = 10;
  store.put("meeting", "meeting", edited);
  const patch = {
    meetingId: "meeting",
    topics: [
      {
        id: null,
        title: "検索画面の方式",
        summary: "一覧から条件を絞り込む方式で進める。速度は未計測。",
        decisions: ["一覧から絞り込む方式を採用する"],
        openQuestions: ["検索速度の確認"],
        sourceIds: ["a", "b"],
      },
    ],
  };
  const allowed = new Set(statements.map((statement) => statement.id));
  assert.equal(knowledge.apply("project", patch, allowed), true);
  let meeting = store.get<Meeting>("meeting", "meeting")!;
  const id = meeting.knowledge!.topics[0].id;
  assert.equal(meeting.summary, "# 人が編集した議事録\n検索速度の計測予算は担当者が確認する。");
  assert.equal(meeting.summaryRevision, 7);
  assert.deepEqual(meeting.knowledge!.topics[0].openQuestions, [
    "検索速度の確認",
  ]);
  const correction = {
    meetingId: "meeting",
    topics: [
      {
        ...patch.topics[0],
        id,
        summary: "一覧の絞り込み方式を採用。速度の計測は明日の会議で扱う。",
        decisions: ["一覧から絞り込む方式を採用する", "速度の計測は明日扱う"],
        openQuestions: ["未計測の検索速度"],
        sourceIds: ["c"],
      },
    ],
  };
  assert.equal(knowledge.apply("project", correction, allowed), true);
  meeting = store.get<Meeting>("meeting", "meeting")!;
  assert.equal(meeting.knowledge!.topics.length, 1);
  assert.deepEqual(meeting.knowledge!.topics[0].sourceIds, ["a", "b", "c"]);
  assert.equal(knowledge.apply("project", correction, allowed), false);
  for (const invalid of ["foreign", "bot", "partial", "invented"])
    assert.equal(
      knowledge.apply(
        "project",
        {
          meetingId: "meeting",
          topics: [
            {
              ...patch.topics[0],
              id,
              summary: "不正な上書き",
              sourceIds: [invalid],
            },
          ],
        },
        allowed,
      ),
      false,
    );
  assert.deepEqual(store.get<Message>("message", "a"), statements[0]);
  store.db.close();
  store = new Store(directory);
  const restored = new MeetingKnowledgeStore(store);
  const search = restored.search("project", { query: "検索 速度", limit: 1 });
  assert.equal(search.documents?.[0].markdown, edited.summary);
  assert.equal(search.documents?.[0].revision, 7);
  assert.equal(search.topics[0].id, id);
  assert.equal(search.nextOffset, 1);
  assert.ok(
    search.messages.every((message) => message.meetingId === "meeting"),
  );
  const raw = restored.search("project", { sourceIds: ["a", "foreign"] });
  assert.deepEqual(
    raw.messages.map((message) => message.id),
    ["a"],
  );
  assert.equal(raw.messages[0].authorName, "話者A");
  assert.equal(raw.messages[0].text, statements[0].text);
  assert.throws(
    () => restored.search("project", { meetingId: "other-meeting" }),
    /MEETING_NOT_FOUND/,
  );
  assert.throws(
    () => restored.search("project", { offset: -1 }),
    /INVALID_KNOWLEDGE_QUERY/,
  );
  store.put("speech-sources", "a", { partIds: ["a", "b"] });
  assert.equal(
    restored.apply(
      "project",
      {
        meetingId: "meeting",
        topics: [
          {
            ...patch.topics[0],
            id: null,
            title: "分割発話の参照",
            sourceIds: ["a"],
          },
        ],
      },
      allowed,
    ),
    true,
  );
  assert.deepEqual(
    store.get<Meeting>("meeting", "meeting")!.knowledge!.topics.at(-1)!
      .sourceIds,
    ["a", "b"],
  );
});

test("minutes schema rejects malformed references and retains source-backed topic updates", () => {
  const response = {
    reply: null,
    tasks: [],
    controls: [],
    minutes: [
      {
        meetingId: "meeting",
        topics: [
          {
            id: null,
            title: "議題",
            summary: "合意はまだない。",
            decisions: [],
            openQuestions: ["比較方法"],
            sourceIds: ["source"],
          },
        ],
      },
    ],
  };
  assert.deepEqual(
    parseCoordinatorResponse(JSON.stringify(response)),
    response,
  );
  response.minutes[0].topics[0].sourceIds = [];
  assert.throws(
    () => parseCoordinatorResponse(JSON.stringify(response)),
    /INVALID_COORDINATOR_RESPONSE/,
  );
});
