import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Command, User } from "@ido/common/contracts/protocol";
import { hash, passwordHash, secret } from "@ido/common/runtime/platform";
import {
  describeError,
  type Diagnostic,
  type DiagnosticContext,
} from "../../domain/diagnostics.js";
import { migrate } from "./migrations.js";

import type { Meeting, Message } from "../../domain/models.js";
export type { Device, Meeting } from "../../domain/models.js";
export class Store {
  db: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(directory, "engine.sqlite"));
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, role TEXT NOT NULL, password TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, userId TEXT NOT NULL REFERENCES users(id), csrf TEXT NOT NULL, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS diagnostics (seq INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, taskId TEXT NOT NULL);`);
    migrate(this.db, directory);
    this.transaction(() => {
      for (const kind of ["input", "message"])
        for (const value of this.list<{
          id: string;
          stage: string;
          steps?: Record<string, { state: string }>;
        }>(kind)) {
          let changed = false;
          if (
            ["accepted", "transcribing", "analyzing", "taskifying"].includes(
              value.stage,
            )
          ) {
            value.stage = "interrupted";
            changed = true;
          }
          for (const step of Object.values(value.steps ?? {}))
            if (["pending", "running"].includes(step.state)) {
              step.state = "interrupted";
              changed = true;
            }
          if (changed) this.put(kind, value.id, value);
        }
    });
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    if (!row) return undefined;
    const value = JSON.parse(row.data as string);
    if (kind === "meeting")
      value.messages = this.list<Message>("message").filter(
        (m) => m.meetingId === id,
      );
    return value as T;
  }
  list<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT data FROM records WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((r) => {
        const value = JSON.parse(r.data as string);
        if (kind === "meeting")
          value.messages = this.list<Message>("message").filter(
            (m) => m.meetingId === value.id,
          );
        return value;
      });
  }
  put(kind: string, id: string, data: unknown) {
    if (kind === "meeting") {
      const { messages, ...meeting } = data as Meeting;
      for (const message of messages ?? [])
        this.put("message", message.id, { ...message, meetingId: id });
      data = meeting;
    }
    this.db
      .prepare(
        "INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data",
      )
      .run(kind, id, JSON.stringify(data));
  }
  remove(kind: string, id: string) {
    this.db.prepare("DELETE FROM records WHERE kind=? AND id=?").run(kind, id);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  users(): User[] {
    return this.db
      .prepare("SELECT id,name,role FROM users")
      .all() as unknown as User[];
  }
  user(id: string) {
    return this.users().find((u) => u.id === id);
  }
  // Conversation participants are not dashboard accounts and cannot log in or pair devices.
  conversationAuthor(id: string): User | undefined {
    return this.user(id) ?? this.get<User>("participant", id);
  }
  createUser(name: string, password: string, role: User["role"]): User {
    const user = { id: randomUUID(), name, role };
    this.db
      .prepare("INSERT INTO users VALUES (?,?,?,?)")
      .run(user.id, name, role, passwordHash(password));
    this.audit(user.id, "user.create", user.id);
    return user;
  }
  session(userId: string) {
    const token = secret(),
      csrf = secret();
    this.db.prepare("DELETE FROM sessions WHERE expires<?").run(Date.now());
    this.db
      .prepare("INSERT INTO sessions VALUES (?,?,?,?)")
      .run(hash(token), userId, csrf, Date.now() + 8 * 3600000);
    return { token, csrf };
  }
  audit(actor: string, action: string, target: string) {
    this.db
      .prepare("INSERT INTO audit(at,actor,action,target) VALUES (?,?,?,?)")
      .run(Date.now(), actor, action, target);
  }
  events() {
    return this.db
      .prepare(
        "SELECT at,actor,action,target FROM audit ORDER BY seq DESC LIMIT 200",
      )
      .all();
  }
  logError(error: unknown, context: DiagnosticContext): Diagnostic {
    const entry: Diagnostic = {
      id: randomUUID(),
      at: Date.now(),
      level: "error",
      ...context,
      error: describeError(error),
    };
    this.db
      .prepare("INSERT INTO diagnostics(data) VALUES (?)")
      .run(JSON.stringify(entry));
    this.db.exec(
      "DELETE FROM diagnostics WHERE seq NOT IN (SELECT seq FROM diagnostics ORDER BY seq DESC LIMIT 500)",
    );
    return entry;
  }
  diagnostics(): Diagnostic[] {
    return this.db
      .prepare("SELECT data FROM diagnostics ORDER BY seq DESC LIMIT 100")
      .all()
      .map((row) => JSON.parse(row.data as string));
  }
  requestTask(key: string): string | undefined {
    return this.db.prepare("SELECT taskId FROM requests WHERE key=?").get(key)
      ?.taskId as string | undefined;
  }
  rememberRequest(key: string, taskId: string) {
    this.db.prepare("INSERT INTO requests VALUES (?,?)").run(key, taskId);
  }
  enqueue(deviceId: string, command: Omit<Command, "v">) {
    const value = { ...command, v: 1, id: randomUUID() };
    this.db
      .prepare("INSERT INTO outbox VALUES (?,?,?)")
      .run(value.id, deviceId, JSON.stringify(value));
    return value;
  }
  pending(deviceId: string): Command[] {
    return this.db
      .prepare("SELECT data FROM outbox WHERE deviceId=? ORDER BY rowid")
      .all(deviceId)
      .map((r) => JSON.parse(r.data as string));
  }
  ack(deviceId: string, id: string) {
    this.db
      .prepare("DELETE FROM outbox WHERE id=? AND deviceId=?")
      .run(id, deviceId);
  }
  close() {
    this.db.close();
  }
}
