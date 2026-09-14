import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { passwordHash, hash, secret } from "../../common/src/platform.js";
import type {
  Task,
  User,
  Project,
  Grant,
  Command,
} from "../../common/src/protocol.js";

export interface Device {
  id: string;
  name: string;
  userId: string;
  publicKey: string;
  revoked: boolean;
  generation: number;
  grants: Grant[];
  slots: number;
  lastAssigned: number;
}
export interface Meeting {
  id: string;
  name: string;
  projectId?: string;
  summary: string;
  messages: Array<{
    id: string;
    authorId: string;
    text: string;
    at: number;
    stage: string;
  }>;
}
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
      CREATE TABLE IF NOT EXISTS outbox (id TEXT PRIMARY KEY, deviceId TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (key TEXT PRIMARY KEY, taskId TEXT NOT NULL);`);
  }
  get<T>(kind: string, id: string): T | undefined {
    const row = this.db
      .prepare("SELECT data FROM records WHERE kind=? AND id=?")
      .get(kind, id);
    return row ? JSON.parse(row.data as string) : undefined;
  }
  list<T>(kind: string): T[] {
    return this.db
      .prepare("SELECT data FROM records WHERE kind=? ORDER BY rowid")
      .all(kind)
      .map((r) => JSON.parse(r.data as string));
  }
  put(kind: string, id: string, data: unknown) {
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
  createTask(
    input: Pick<
      Task,
      "projectId" | "meetingId" | "authorId" | "text" | "requestId" | "network"
    >,
  ): Task {
    if (!this.get<Project>("project", input.projectId))
      throw new Error("PROJECT_NOT_FOUND");
    return this.transaction(() => {
      const key = JSON.stringify([
        input.authorId,
        input.projectId,
        input.requestId,
      ]);
      const previous = this.db
        .prepare("SELECT taskId FROM requests WHERE key=?")
        .get(key);
      if (previous) return this.get<Task>("task", previous.taskId as string)!;
      const task: Task = {
        ...input,
        id: randomUUID(),
        runId: randomUUID(),
        revision: 1,
        state: "queued",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        history: [],
      };
      this.put("task", task.id, task);
      this.db.prepare("INSERT INTO requests VALUES (?,?)").run(key, task.id);
      this.audit(input.authorId, "task.create", task.id);
      return task;
    });
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
  schedule(online: Set<string>) {
    return this.transaction(() => {
      const tasks = this.list<Task>("task");
      const devices = this.list<Device>("device").filter(
        (d) =>
          online.has(d.id) &&
          !d.revoked &&
          this.user(d.userId)?.role !== "viewer",
      );
      for (const task of tasks.filter(
        (t) => t.state === "queued" && !t.clientId,
      )) {
        const active = (device: Device) =>
          tasks.filter(
            (t) =>
              t.clientId === device.id &&
              ["assigned", "running", "interrupted"].includes(t.state),
          ).length;
        const eligible = devices.filter(
          (d) =>
            d.slots > active(d) &&
            d.grants.some(
              (g) =>
                g.projectId === task.projectId &&
                (!task.network || g.network) &&
                tasks.filter(
                  (t) =>
                    t.clientId === d.id &&
                    t.projectId === g.projectId &&
                    ["assigned", "running", "interrupted"].includes(t.state),
                ).length < g.slots,
            ),
        );
        eligible.sort(
          (a, b) =>
            b.slots - active(b) - (a.slots - active(a)) ||
            a.lastAssigned - b.lastAssigned ||
            a.id.localeCompare(b.id),
        );
        const device = eligible[0];
        if (!device) continue;
        task.clientId = device.id;
        task.state = "assigned";
        task.updatedAt = Date.now();
        device.lastAssigned = Date.now();
        this.put("task", task.id, task);
        this.put("device", device.id, device);
        this.enqueue(device.id, {
          type: "execute",
          taskId: task.id,
          runId: task.runId,
          task,
        });
      }
    });
  }
  updateResult(deviceId: string, generation: number, data: Command) {
    const device = this.get<Device>("device", deviceId),
      task = this.get<Task>("task", String(data.taskId));
    if (
      !device ||
      device.revoked ||
      generation !== device.generation ||
      !task ||
      task.clientId !== deviceId ||
      task.runId !== data.runId ||
      data.revision !== task.revision
    )
      return false;
    if (["completed", "failed", "cancelled"].includes(task.state)) return false;
    const next = data.state;
    if (
      !["running", "interrupted", "completed", "failed", "cancelled"].includes(
        String(next),
      )
    )
      return false;
    task.state = next as Task["state"];
    task.progress =
      typeof data.progress === "string"
        ? data.progress.slice(0, 16000)
        : task.progress;
    if (typeof data.result === "string")
      task.result = data.result.slice(0, 64000);
    task.updatedAt = Date.now();
    this.put("task", task.id, task);
    return true;
  }
  control(
    taskId: string,
    actor: string,
    type: "steer" | "stop" | "retry",
    text?: string,
  ) {
    return this.transaction(() => {
      const task = this.get<Task>("task", taskId);
      if (!task) throw new Error("TASK_NOT_FOUND");
      if (type === "stop" && task.state === "queued") {
        task.state = "cancelled";
        this.put("task", task.id, task);
        return;
      }
      if (!task.clientId) throw new Error("TASK_NOT_ASSIGNED");
      if (type === "retry") {
        if (
          !["completed", "failed", "cancelled", "interrupted"].includes(
            task.state,
          )
        )
          throw new Error("TASK_STILL_ACTIVE");
        task.history.push({
          revision: task.revision,
          text: task.text,
          result: task.result,
        });
        task.revision++;
        task.result = undefined;
        task.state = "assigned";
      } else if (
        type === "steer" &&
        !["assigned", "running"].includes(task.state)
      )
        throw new Error("TASK_NOT_RUNNING");
      this.put("task", task.id, task);
      this.enqueue(task.clientId, {
        type,
        taskId: task.id,
        runId: task.runId,
        revision: task.revision,
        text,
        task,
      });
      this.audit(actor, `task.${type}`, taskId);
    });
  }
  close() {
    this.db.close();
  }
}
