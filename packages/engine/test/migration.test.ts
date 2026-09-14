import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Store } from "../src/adapters/sqlite/store.js";
import type { Meeting, Message } from "../src/domain/models.js";
import { Identities } from "../src/management/identities.js";
test("versioned migration preserves messages, identities and publications, backs up WAL, and never replays uncertain inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-migrate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, "engine.sqlite"));
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE records(kind TEXT, id TEXT, data TEXT, PRIMARY KEY(kind,id))",
  );
  const put = (kind: string, id: string, value: unknown) =>
    db
      .prepare("INSERT INTO records VALUES (?,?,?)")
      .run(kind, id, JSON.stringify(value));
  put("meeting", "meeting", {
    id: "meeting",
    name: "Old",
    summary: "Preserved",
    messages: [
      {
        id: "message",
        authorId: "discord-123",
        text: "old text",
        at: 1,
        stage: "analyzing",
      },
    ],
  });
  put("discord-participant", "discord-123", {
    id: "discord-123",
    name: "Speaker",
    role: "member",
  });
  put("discord-publication", "minutes", { messageId: "1234" });
  put("input", "uncertain", { id: "uncertain", stage: "analyzing" });
  put("discord-user", "123", { userId: "member" });
  put("config", "discord", { guildId: "1", userPolicy: "all" });
  let store = new Store(directory);
  db.close();
  assert.deepEqual(store.get("external-identity", "discord:123"), {
    userId: "member",
  });
  assert.deepEqual(store.get("config", "discord"), {
    guildId: "1",
    userPolicy: "all",
    projectId: "default",
  });
  assert.equal(
    store.get<{ id: string }>("input", "discord:uncertain")!.id,
    "discord:uncertain",
  );
  store.remove("external-identity", "discord:123");
  assert.equal(
    store.get<Meeting>("meeting", "meeting")!.messages[0].text,
    "old text",
  );
  const raw = JSON.parse(
    String(
      store.db.prepare("SELECT data FROM records WHERE kind='meeting'").get()!
        .data,
    ),
  );
  assert.equal(raw.messages, undefined);
  assert.equal(
    new Identities(store).resolve("discord", "123")!.id,
    "discord-123",
  );
  assert.deepEqual(store.get("plugin:discord", "minutes"), {
    messageId: "1234",
  });
  assert.equal(
    store.get<{ stage: string }>("input", "discord:uncertain")!.stage,
    "interrupted",
  );
  assert.equal(
    store.get<Message>("message", "message")!.steps!.minutes!.state,
    "interrupted",
  );
  assert.ok((await stat(join(directory, "engine.before-v1.sqlite"))).size > 0);
  const backup = new DatabaseSync(join(directory, "engine.before-v1.sqlite"), {
    readOnly: true,
  });
  assert.equal(backup.prepare("PRAGMA user_version").get()!.user_version, 0);
  backup.close();
  store.close();
  store = new Store(directory);
  assert.equal(store.list("message").length, 1);
  assert.equal(store.list("task").length, 0);
  store.close();
});

test("project migration preserves IDs and merges historical forum mappings without replaying inputs", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ido-project-migrate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, "engine.sqlite"));
  db.exec(
    "CREATE TABLE records(kind TEXT,id TEXT,data TEXT,PRIMARY KEY(kind,id)); PRAGMA user_version=1;",
  );
  const put = (kind: string, id: string, value: unknown) =>
    db
      .prepare("INSERT INTO records VALUES (?,?,?)")
      .run(kind, id, JSON.stringify(value));
  const { createHash } = await import("node:crypto");
  const key = (parts: string[]) =>
    `forum-${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
  put("project", "project", { id: "project", name: "Existing", remote: "" });
  for (const meetingId of ["a", "b"]) {
    put("meeting", meetingId, {
      id: meetingId,
      projectId: "project",
      name: meetingId,
      summary: "",
    });
    put("task", `task-${meetingId}`, {
      id: `task-${meetingId}`,
      projectId: "project",
      meetingId,
      state: "running",
    });
    put("plugin:discord", key(["guild", "forum", meetingId, "project"]), [
      {
        taskId: `task-${meetingId}`,
        threadId: `thread-${meetingId}`,
        marker: `IDO task task-${meetingId}`,
      },
    ]);
  }
  put("meeting", "unassigned", { id: "unassigned", name: "Old", summary: "" });
  put("input", "discord:pending", {
    id: "discord:pending",
    meetingId: "a",
    stage: "transcribing",
  });
  put("config", "discord", {
    guildId: "guild",
    issueForumChannelId: "forum",
    meetingId: "b",
    projectId: "project",
    clientSetting: "preserve",
  });
  db.close();
  const store = new Store(directory);
  assert.equal(store.get<any>("meeting", "unassigned").projectId, "default");
  assert.equal(store.get<any>("task", "task-a").meetingId, "a");
  assert.equal(store.get<any>("config", "discord").projectId, "project");
  assert.equal(store.get<any>("config", "discord").meetingId, undefined);
  assert.equal(store.get<any>("config", "discord").clientSetting, "preserve");
  assert.deepEqual(
    store
      .get<any[]>("plugin:discord", key(["guild", "forum", "project"]))!
      .map((r) => r.threadId),
    ["thread-a", "thread-b"],
  );
  assert.equal(store.get<any>("input", "discord:pending").stage, "interrupted");
  const backup = new DatabaseSync(join(directory, "engine.before-v2.sqlite"), {
    readOnly: true,
  });
  assert.equal(backup.prepare("PRAGMA user_version").get()!.user_version, 1);
  backup.close();
  store.close();
});
