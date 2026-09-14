import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

// VACUUM INTO includes committed WAL contents. Never copy a live SQLite file.
export function migrate(db: DatabaseSync, directory: string) {
  const version = Number(
    db.prepare("PRAGMA user_version").get()?.user_version ?? 0,
  );
  if (version > 1) throw new Error("DATABASE_VERSION_UNSUPPORTED");
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
