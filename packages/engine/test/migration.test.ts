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
