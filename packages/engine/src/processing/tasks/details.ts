import { createHash } from "node:crypto";
import {
  parseTaskDetail,
  type TaskDetailSnapshot,
  type TaskDetailRead,
  type TaskDetailPage,
} from "@ido/common/contracts/api";
import { id, type Task } from "@ido/common/contracts/protocol";
import type { Device } from "../../domain/models.js";
import type { Repository } from "../../ports/repository.js";
import { ProjectTeam } from "../projects/team.js";

// Base64-encoded chunks remain below 256 KiB even after JSON framing.
export const DETAIL_CHUNK_BYTES = 128 * 1024;
const MAX_BYTES = 16 * 1024 * 1024;
interface SavedDetail {
  snapshot: TaskDetailSnapshot;
  digest: string;
  syncedAt: number;
}
interface Upload {
  generation: number;
  sequence: number;
  revision: number;
  runId: string;
  digest: string;
  total: number;
  parts: Map<number, Buffer>;
  at: number;
}
const integer = (v: unknown, min: number, max: number) => {
  if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max)
    throw new Error("INVALID_DETAIL");
  return Number(v);
};
export class TaskDetails {
  private reads = new Map<
    string,
    { taskId: string; deviceId: string; bytes: Buffer; at: number }
  >();
  invalidate(taskId: string) {
    for (const [key, value] of this.reads)
      if (value.taskId === taskId) this.reads.delete(key);
    for (const key of this.uploads.keys())
      if (key.endsWith(`:${taskId}`)) this.uploads.delete(key);
  }
  private uploads = new Map<string, Upload>();
  constructor(readonly store: Repository) {}
  task(deviceId: string, taskId: string) {
    const task = this.store.get<Task>("task", id(taskId));
    if (!task) throw new Error("TASK_NOT_FOUND");
    new ProjectTeam(this.store).require(deviceId, task.projectId);
    return task;
  }
  sync(deviceId: string, generation: number, input: Record<string, unknown>) {
    const task = this.task(deviceId, String(input.taskId));
    const device = this.store.get<Device>("device", deviceId);
    if (
      device?.generation !== generation ||
      task.clientId !== deviceId ||
      task.runId !== input.runId ||
      task.revision !== input.revision
    )
      throw new Error("TASK_ASSIGNMENT_CHANGED");
    const sequence = integer(input.sequence, 1, Number.MAX_SAFE_INTEGER);
    const total = integer(input.total, 1, MAX_BYTES / DETAIL_CHUNK_BYTES);
    const index = integer(input.index, 0, total - 1);
    if (
      typeof input.digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.digest) ||
      typeof input.data !== "string" ||
      input.data.length > 180000 ||
      !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)
    )
      throw new Error("INVALID_DETAIL");
    const bytes = Buffer.from(input.data, "base64");
    if (
      !bytes.length ||
      bytes.length > DETAIL_CHUNK_BYTES ||
      bytes.toString("base64") !== input.data
    )
      throw new Error("INVALID_DETAIL");
    const saved = this.store.get<SavedDetail>("task-detail", task.id);
    if (
      saved &&
      saved.snapshot.revision === task.revision &&
      saved.snapshot.sequence >= sequence
    ) {
      if (saved.snapshot.sequence === sequence && saved.digest !== input.digest)
        throw new Error("DETAIL_SEQUENCE_CONFLICT");
      return { complete: true, sequence: saved.snapshot.sequence };
    }
    for (const [key, upload] of this.uploads)
      if (Date.now() - upload.at > 60000) this.uploads.delete(key);
    const key = `${deviceId}:${task.id}`;
    let upload = this.uploads.get(key);
    if (
      upload &&
      upload.generation === generation &&
      upload.revision === task.revision &&
      upload.sequence > sequence
    )
      throw new Error("STALE_DETAIL");
    if (
      !upload ||
      upload.sequence !== sequence ||
      upload.generation !== generation ||
      upload.revision !== task.revision
    ) {
      if (
        !this.uploads.has(key) &&
        [...this.uploads.keys()].filter((k) => k.startsWith(`${deviceId}:`))
          .length >= 4
      )
        throw new Error("DETAIL_UPLOAD_BUSY");
      upload = {
        generation,
        sequence,
        revision: task.revision,
        runId: task.runId,
        digest: input.digest,
        total,
        parts: new Map(),
        at: Date.now(),
      };
      this.uploads.set(key, upload);
    }
    if (upload.digest !== input.digest || upload.total !== total)
      throw new Error("DETAIL_SEQUENCE_CONFLICT");
    upload.parts.set(index, bytes);
    if (upload.parts.size !== total) return { complete: false, sequence };
    const body = Buffer.concat(
      Array.from({ length: total }, (_, n) => upload!.parts.get(n)!),
    );
    if (
      body.length > MAX_BYTES ||
      createHash("sha256").update(body).digest("hex") !== upload.digest
    ) {
      this.uploads.delete(key);
      throw new Error("INVALID_DETAIL");
    }
    const snapshot = parseTaskDetail(JSON.parse(body.toString()));
    if (
      snapshot.version !== 1 ||
      snapshot.taskId !== task.id ||
      snapshot.runId !== task.runId ||
      snapshot.revision !== task.revision ||
      snapshot.sequence !== sequence ||
      snapshot.run?.task?.id !== task.id ||
      snapshot.run.task.runId !== task.runId ||
      snapshot.run.task.revision !== task.revision ||
      snapshot.run.task.projectId !== task.projectId ||
      !Array.isArray(snapshot.activity?.entries) ||
      !Array.isArray(snapshot.approvals)
    )
      throw new Error("INVALID_DETAIL");
    this.store.put("task-detail", task.id, {
      snapshot,
      digest: upload.digest,
      syncedAt: Date.now(),
    } satisfies SavedDetail);
    this.uploads.delete(key);
    return { complete: true, sequence };
  }
  read(
    deviceId: string,
    input: Record<string, unknown>,
    connected: ReadonlyMap<string, unknown>,
  ): TaskDetailPage {
    const task = this.task(deviceId, String(input.taskId));
    const saved = this.store.get<SavedDetail>("task-detail", task.id);
    const value: TaskDetailRead = {
      task,
      snapshot: saved?.snapshot,
      syncedAt: saved?.syncedAt,
      ownerConnected: !!task.clientId && connected.has(task.clientId),
      supported: true,
    };
    for (const [key, cached] of this.reads)
      if (Date.now() - cached.at > 60000) this.reads.delete(key);
    let bytes: Buffer, token: string;
    if (input.token !== undefined) {
      if (typeof input.token !== "string") throw new Error("INVALID_DETAIL");
      const cached = this.reads.get(`${deviceId}:${task.id}:${input.token}`);
      if (!cached) throw new Error("DETAIL_CHANGED");
      bytes = cached.bytes;
      token = input.token;
    } else {
      bytes = Buffer.from(JSON.stringify(value));
      token = createHash("sha256").update(bytes).digest("hex");
      if (bytes.length > DETAIL_CHUNK_BYTES) {
        const existing = [...this.reads].filter(
          ([, cached]) => cached.deviceId === deviceId,
        );
        if (existing.length >= 4) this.reads.delete(existing[0][0]);
        this.reads.set(`${deviceId}:${task.id}:${token}`, {
          deviceId,
          taskId: task.id,
          bytes,
          at: Date.now(),
        });
      }
    }
    const offset = integer(input.offset ?? 0, 0, bytes.length);
    const end = Math.min(offset + DETAIL_CHUNK_BYTES, bytes.length);
    return {
      token,
      data: bytes.subarray(offset, end).toString("base64"),
      nextOffset: end < bytes.length ? end : undefined,
    };
  }
}
