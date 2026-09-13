import { readdir, lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Opt-in metadata only. Never read rollouts/auth, resume threads, or send to Bot.
// Codex's local schema is not a stable API. Missing/changed schemas fail closed.
export class LocalCodexTasks {
  constructor({
    directory = process.env.CODEX_HOME || join(homedir(), ".codex"),
    now = Date.now,
  } = {}) {
    this.directory = directory;
    this.now = now;
    this.enabled = false;
    this.cache = { tasks: [], available: false };
    this.checkedAt = 0;
  }
  setEnabled(value) {
    this.enabled = value;
    this.cache = { tasks: [], available: false };
    this.checkedAt = 0;
  }
  async list() {
    if (!this.enabled) return { enabled: false, tasks: [] };
    if (this.checkedAt && this.now() - this.checkedAt < 10000)
      return { ...this.cache, enabled: true };
    this.checkedAt = this.now();
    let db;
    try {
      const names = (await readdir(this.directory))
        .filter((name) => /^state_\d+\.sqlite$/.test(name))
        .sort((a, b) => Number(b.match(/\d+/)[0]) - Number(a.match(/\d+/)[0]));
      if (!names.length) throw new Error("Unavailable");
      const path = join(this.directory, names[0]);
      if (!(await lstat(path)).isFile()) throw new Error("Not a regular file");
      const { DatabaseSync } = await import("node:sqlite");
      db = new DatabaseSync(path, { readOnly: true });
      db.exec("PRAGMA busy_timeout=100");
      const rows = db
        .prepare(
          `
        SELECT id, substr(title,1,200) AS title, substr(cwd,1,2000) AS cwd,
          created_at, updated_at
        FROM threads WHERE archived = 0 AND has_user_event = 1 AND updated_at >= ?
        ORDER BY updated_at DESC LIMIT 30
      `,
        )
        .all(Math.floor(this.now() / 1000) - 7 * 86400);
      this.cache = {
        available: true,
        tasks: rows.map((row) => ({
          id: `local:${row.id}`,
          title: row.title || "Codexのタスク",
          workingDirectory: row.cwd,
          startedAt: row.created_at * 1000,
          updatedAt: row.updated_at * 1000,
          source: "codex-local",
          state: "external",
          logs: [],
          request:
            "Codex App・CLIの直近7日・最大30件のタスクです。実行状態は取得できません。進捗の確認・停止は元のCodexで行ってください。",
        })),
      };
    } catch {
      this.cache = { available: false, tasks: [] };
    } finally {
      db?.close();
    }
    // A pending read must not re-enable the feature after it has been disabled.
    if (!this.enabled) {
      this.cache = { available: false, tasks: [] };
      return { enabled: false, tasks: [] };
    }
    return { ...this.cache, enabled: true };
  }
}
