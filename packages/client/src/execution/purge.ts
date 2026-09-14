import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Executor } from "./executor.js";

/** Only IDO's managed model logs are removed. Git worktrees are preserved. */
async function removeThreadLogs(directory: string, threadIds: string[]) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await removeThreadLogs(path, threadIds);
    else if (
      entry.isFile() &&
      threadIds.some(
        (id) =>
          entry.name === `${id}.jsonl` || entry.name.endsWith(`-${id}.jsonl`),
      )
    )
      await unlink(path);
  }
}
// Codex keeps task titles/initial prompts in its managed SQLite index as well.
// Discover supported thread keys from the schema; never touch unrelated rows.
async function removeThreadMetadata(home: string, threadIds: string[]) {
  if (!threadIds.length) return;
  const entries = await readdir(home, { withFileTypes: true });
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  for (const entry of entries) {
    if (!entry.isFile() || !/^state_\d+\.sqlite$/.test(entry.name)) continue;
    const db = new DatabaseSync(join(home, entry.name));
    try {
      db.exec(
        "PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; BEGIN IMMEDIATE",
      );
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => String(row.name));
      for (const table of tables
        .filter((name) => name !== "threads")
        .concat(tables.includes("threads") ? ["threads"] : [])) {
        const columns = db
          .prepare(`PRAGMA table_info(${quote(table)})`)
          .all()
          .map((row) => row.name);
        const column =
          table === "threads" && columns.includes("id")
            ? "id"
            : columns.includes("thread_id")
              ? "thread_id"
              : undefined;
        if (!column) continue;
        for (const id of threadIds)
          db.prepare(
            `DELETE FROM ${quote(table)} WHERE ${quote(column)}=?`,
          ).run(id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    } finally {
      db.close();
    }
  }
}
export async function purge(this: Executor, taskId: string) {
  const runs = Object.values(this.runs).filter(
    (r) => r.origin !== "local" && r.task.id === taskId,
  );
  this.deletedTasks[taskId] = true;
  this.pendingPurges[taskId] = [
    ...new Set([
      ...(this.pendingPurges[taskId] ?? []),
      ...runs.flatMap((r) => (r.threadId ? [r.threadId] : [])),
    ]),
  ];
  await this.save();
  for (const run of runs) {
    this.active.get(run.task.runId)?.abort.abort();
    await this.running.get(run.task.runId);
    await this.steering.get(run.task.runId);
    for (const [id, approval] of this.approvals)
      if (approval.runId === run.task.runId) {
        clearTimeout(approval.timer);
        approval.resolve({ decision: "decline" });
        this.approvals.delete(id);
      }
    this.planWaiters.delete(run.task.runId);
    delete this.runs[run.task.runId];
  }
  await this.save();
  for (const folder of ["sessions", "archived_sessions"])
    await removeThreadLogs(join(this.home, folder), this.pendingPurges[taskId]);
  await removeThreadMetadata(this.home, this.pendingPurges[taskId]);
  delete this.pendingPurges[taskId];
  await this.save();
}
