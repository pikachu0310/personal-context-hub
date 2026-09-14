import { createHash } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

// VACUUM INTO includes committed WAL contents. Never copy a live SQLite file.
function migrateV1(db: DatabaseSync, directory: string) {
  const version = Number(
    db.prepare("PRAGMA user_version").get()?.user_version ?? 0,
  );
  if (version > 1) return;
  if (version === 1) return;
  const backup = join(directory, "engine.before-v1.sqlite");
  if (!existsSync(backup)) db.prepare("VACUUM INTO ?").run(backup);
  if (process.platform !== "win32") chmodSync(backup, 0o600);
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare("SELECT kind,id,data FROM records").all();
    const write = db.prepare("INSERT OR REPLACE INTO records VALUES (?,?,?)");
    for (const row of rows) {
      const value = JSON.parse(String(row.data));
      if (row.kind === "meeting") {
        const { messages = [], ...meeting } = value;
        for (const message of messages)
          write.run(
            "message",
            message.id,
            JSON.stringify({
              ...message,
              meetingId: row.id,
              steps: {
                minutes: {
                  state:
                    message.stage === "completed"
                      ? "completed"
                      : message.stage === "failed"
                        ? "failed"
                        : "interrupted",
                  errorId: message.errorId,
                },
              },
            }),
          );
        write.run("meeting", row.id, JSON.stringify(meeting));
      }
      if (row.kind === "discord-participant") {
        write.run("participant", row.id, row.data);
        write.run(
          "external-participant",
          `discord:${String(row.id).replace(/^discord-/, "")}`,
          JSON.stringify({ actorId: row.id }),
        );
      }
      if (row.kind === "discord-user")
        write.run("external-identity", `discord:${row.id}`, row.data);
      if (row.kind === "discord-publication")
        write.run("plugin:discord", row.id, row.data);
      if (row.kind === "input")
        write.run(
          "input",
          `discord:${row.id}`,
          JSON.stringify({
            ...value,
            id: `discord:${row.id}`,
            stage: [
              "completed",
              "failed",
              "ignored",
              "discarded",
              "denied",
              "partial",
            ].includes(value.stage)
              ? value.stage
              : "interrupted",
          }),
        );
    }
    for (const row of rows)
      if (row.kind === "input")
        db.prepare("DELETE FROM records WHERE kind='input' AND id=?").run(
          row.id,
        );
    db.exec(
      "DELETE FROM records WHERE kind IN ('discord-participant','discord-user','discord-publication'); PRAGMA user_version=1; COMMIT",
    );
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateV2(db: DatabaseSync, directory: string) {
  const version = Number(
    db.prepare("PRAGMA user_version").get()?.user_version ?? 0,
  );
  if (version > 2) return;
  migrateV1(db, directory);
  if (version === 2) return;
  const backup = join(directory, "engine.before-v2.sqlite");
  if (!existsSync(backup)) db.prepare("VACUUM INTO ?").run(backup);
  if (process.platform !== "win32") chmodSync(backup, 0o600);
  db.exec("BEGIN IMMEDIATE");
  try {
    const write = db.prepare("INSERT OR REPLACE INTO records VALUES (?,?,?)");
    write.run(
      "project",
      "default",
      JSON.stringify({
        id: "default",
        name: "デフォルト",
        remote: "",
        isDefault: true,
      }),
    );
    for (const row of db
      .prepare(
        "SELECT kind,id,data FROM records WHERE kind IN ('meeting','config','voice-route')",
      )
      .all()) {
      const value = JSON.parse(String(row.data));
      if (row.kind === "meeting" && !value.projectId)
        write.run(
          row.kind,
          row.id,
          JSON.stringify({ ...value, projectId: "default" }),
        );
      if (row.kind === "config" && row.id === "discord") {
        const meeting =
          value.meetingId &&
          db
            .prepare("SELECT data FROM records WHERE kind='meeting' AND id=?")
            .get(value.meetingId);
        value.projectId ||= meeting
          ? (JSON.parse(String(meeting.data)).projectId ?? "default")
          : "default";
        if (value.issueForumChannelId) {
          const key = (parts: string[]) =>
            `forum-${createHash("sha256").update(JSON.stringify(parts)).digest("hex")}`;
          const bindings = db
            .prepare("SELECT id,data FROM records WHERE kind='meeting'")
            .all()
            .map((m) => ({
              meetingId: String(m.id),
              projectId: JSON.parse(String(m.data)).projectId ?? "default",
            }));
          if (value.meetingId)
            bindings.push({
              meetingId: value.meetingId,
              projectId: value.projectId,
            });
          for (const binding of bindings) {
            const oldKey = key([
              value.guildId,
              value.issueForumChannelId,
              binding.meetingId,
              binding.projectId,
            ]);
            const newKey = key([
              value.guildId,
              value.issueForumChannelId,
              binding.projectId,
            ]);
            const read = (id: string) =>
              db
                .prepare(
                  "SELECT data FROM records WHERE kind='plugin:discord' AND id=?",
                )
                .get(id);
            const old = read(oldKey);
            if (!old) continue;
            const current = read(newKey);
            const records = current ? JSON.parse(String(current.data)) : [];
            for (const record of JSON.parse(String(old.data)))
              if (
                !records.some(
                  (r: { taskId: string }) => r.taskId === record.taskId,
                )
              )
                records.push(record);
            write.run("plugin:discord", newKey, JSON.stringify(records));
          }
        }
        delete value.meetingId;
        write.run(row.kind, row.id, JSON.stringify(value));
      }
    }
    db.exec("PRAGMA user_version=2; COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function migrate(db: DatabaseSync, directory: string) {
  const version = Number(
    db.prepare("PRAGMA user_version").get()?.user_version ?? 0,
  );
  if (version > 3) throw new Error("DATABASE_VERSION_UNSUPPORTED");
  migrateV2(db, directory);
  if (version === 3) return;
  const backup = join(directory, "engine.before-v3.sqlite");
  if (!existsSync(backup)) db.prepare("VACUUM INTO ?").run(backup);
  if (process.platform !== "win32") chmodSync(backup, 0o600);
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = (kind: string) =>
      db
        .prepare("SELECT id,data FROM records WHERE kind=? ORDER BY rowid")
        .all(kind);
    const devices = rows("device")
      .map((r) => JSON.parse(String(r.data)))
      .filter((d) => !d.revoked);
    const receipts = rows("project-create");
    const write = db.prepare("INSERT OR REPLACE INTO records VALUES (?,?,?)");
    for (const row of rows("project")) {
      const project = JSON.parse(String(row.data));
      for (const device of devices)
        write.run(
          "project-member",
          `${project.id}:${device.id}`,
          JSON.stringify({ projectId: project.id, deviceId: device.id }),
        );
      if (!project.isDefault && !project.ownerDeviceId) {
        const receipt = receipts.find(
          (r) => JSON.parse(String(r.data)).projectId === project.id,
        );
        const creator =
          receipt &&
          devices.find((d) => String(receipt.id).startsWith(`${d.id}:`));
        if (creator) {
          project.ownerDeviceId = creator.id;
          write.run("project", project.id, JSON.stringify(project));
        }
      }
    }
    db.exec("PRAGMA user_version=3; COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
