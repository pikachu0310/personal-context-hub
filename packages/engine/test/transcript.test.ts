import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { Store } from "../src/adapters/sqlite/store.js";
import { ProjectTeam } from "../src/processing/projects/team.js";
import { transcriptPage } from "../src/processing/minutes/transcript.js";
import type { Message } from "../src/domain/models.js";

test("large meetings have compact snapshots and searchable original statements with stable cursors", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-transcript-"));
  const store = new Store(directory);
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const user = store.createUser("reader", "long-fixture-password", "member");
  store.put("device", "device", {
    id: "device",
    userId: user.id,
    revoked: false,
    grants: [],
  });
  for (const id of ["project", "other"]) {
    store.put("project", id, { id, name: id, remote: "" });
    store.put("meeting", id, {
      id,
      projectId: id,
      name: id,
      summary: "",
      messages: [],
      startedAt: 1,
    });
  }
  store.put("project-member", "project:device", {
    projectId: "project",
    deviceId: "device",
  });
  store.transaction(() => {
    for (let i = 0; i < 6000; i++)
      store.put("message", `m${String(i).padStart(5, "0")}`, {
        id: `m${String(i).padStart(5, "0")}`,
        meetingId: "project",
        authorId: "speaker",
        authorName: "話者Ａ",
        text: i === 1 ? "初日に決めた検索仕様の原文" : `発言 ${i}`,
        at: i,
        role: "user",
        stage: "completed",
        capture: { sessionId: "large-capture".repeat(400) },
      });
  });
  const first = transcriptPage(store, "project");
  assert.equal(first.total, 6000);
  assert.equal(first.messages.length, 100);
  assert.equal(first.messages[0].id, "m05999");
  assert.equal(first.messages[0].authorName, "話者Ａ");
  assert.equal("capture" in first.messages[0], false);
  const snapshot = new ProjectTeam(store).snapshot("device", "project");
  assert.equal(snapshot.minutes[0].messageCount, 6000);
  assert.equal(snapshot.minutes[0].messages.length, 100);
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) < 100000);
  assert.equal(
    transcriptPage(store, "project", { query: "検索仕様" }).messages[0].id,
    "m00001",
  );
  assert.equal(
    transcriptPage(store, "project", { query: "話者a" }).total,
    6000,
  );
  store.put("message", "new", {
    id: "new",
    meetingId: "project",
    authorId: "speaker",
    text: "新しい発言",
    at: 9000,
    role: "user",
    stage: "completed",
  });
  const second = transcriptPage(store, "project", { before: first.next });
  assert.equal(second.messages[0].id, "m05899");
  assert.equal(second.messages.at(-1)?.id, "m05800");
  assert.equal(
    new Set([...first.messages, ...second.messages].map((m) => m.id)).size,
    200,
  );
  const meeting = store.get<any>("meeting", "project");
  meeting.knowledge = {
    revision: 1,
    topics: [{ id: "topic", sourceIds: ["m00001", "m00002"] }],
  };
  store.put("meeting", "project", meeting);
  assert.deepEqual(
    transcriptPage(store, "project", {
      meetingId: "project",
      topicId: "topic",
    }).messages.map((m) => m.id),
    ["m00002", "m00001"],
  );
  assert.throws(
    () => transcriptPage(store, "project", { meetingId: "other" }),
    /MEETING_NOT_FOUND/,
  );
  assert.throws(
    () => transcriptPage(store, "other", { topicId: "topic" }),
    /TOPIC_NOT_FOUND/,
  );
  assert.throws(
    () => transcriptPage(store, "project", { before: { at: NaN, id: "bad" } }),
    /INVALID_TRANSCRIPT_QUERY/,
  );
  const original = "省略しない原文。".repeat(6000);
  for (const [i, at] of [10000, 10000, 10001].entries())
    store.put("message", `long-${i}`, {
      id: `long-${i}`,
      meetingId: "project",
      authorId: "speaker",
      text: original,
      at,
      role: "user",
      stage: "completed",
    } satisfies Message);
  const longPage = transcriptPage(store, "project", { query: "省略しない" });
  assert.equal(longPage.messages[0].text, original);
  assert.ok(longPage.messages.reduce((n, m) => n + m.text.length, 0) <= 128000);
  assert.ok(longPage.next);
  const longNext = transcriptPage(store, "project", {
    query: "省略しない",
    before: longPage.next,
  });
  assert.equal(
    new Set([...longPage.messages, ...longNext.messages].map((m) => m.id)).size,
    3,
  );
});
