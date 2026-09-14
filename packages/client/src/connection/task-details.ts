import { createHash } from "node:crypto";
import { hostname } from "node:os";
import { run } from "@ido/common/runtime/platform";
import {
  detailTask,
  sanitizeDetail,
  activityText,
  taskProgress,
  type TaskDetailSnapshot,
  type TaskDetailPage,
  type TaskDetailRead,
  type ProjectWorkspace,
} from "@ido/common/contracts/api";
import type { Client } from "../bootstrap/client.js";
import type { Run } from "../execution/executor.js";

const CHUNK_BYTES = 128 * 1024;
const fingerprintOf = (snapshot: TaskDetailSnapshot) =>
  createHash("sha256")
    .update(JSON.stringify({ ...snapshot, capturedAt: 0, sequence: 0 }))
    .digest("hex");
export function detailSnapshot(
  client: Client,
  value: Run,
  taskId: string,
): TaskDetailSnapshot {
  return sanitizeDetail({
    version: 1,
    taskId,
    runId: value.task.runId,
    revision: value.task.revision,
    sequence: value.detailSync?.sequence ?? 0,
    capturedAt: Date.now(),
    run: {
      task: {
        ...detailTask(value.task),
        id: taskId,
        authorId:
          value.origin === "local"
            ? `client-${client.settings.deviceId}`
            : value.task.authorId,
        clientId: client.settings.deviceId,
      },
      directory: value.directory,
      state: value.state,
      result: value.result,
      progress: taskProgress(value.progress, value.state),
      agent: value.agent,
      model: value.model,
      reasoningEffort: value.reasoningEffort,
      origin: value.origin,
      accessMode: value.accessMode,
      progressMode: value.progressMode,
      pendingProgressMode: value.pendingProgressMode,
      phase: value.phase,
      contextSources: value.contextSources,
      activityVersion: value.activityVersion,
      updatedAt: value.updatedAt,
      discordShare: value.discordShare && {
        projectId: value.discordShare.projectId,
        taskId,
        status: value.discordShare.status,
        error: value.discordShare.error,
      },
    },
    activity: {
      entries: value.activity ?? [],
      dropped: value.activityDropped ?? 0,
      version: value.activityVersion ?? 0,
    },
    plan: value.plan,
    approvals: [...client.executor.approvals]
      .filter(([, a]) => a.runId === value.task.runId)
      .map(([id, a]) => ({
        id,
        runId: a.runId,
        method: a.method,
        params: a.params,
      })),
    ...value.detailResources,
  });
}
export class ClientTaskDetails {
  supported = false;
  private timer?: NodeJS.Timeout;
  private busy = false;
  private resourceJobs = new Map<Run, Promise<void>>();
  private states = new Map<string, string>();
  private wake?: NodeJS.Timeout;
  changed() {
    let changed = false;
    for (const value of Object.values(this.client.executor.runs)) {
      const key = `${value.task.revision}:${value.state}`;
      const previous = this.states.get(value.task.runId);
      this.states.set(value.task.runId, key);
      changed ||= previous !== key;
    }
    if (changed && !this.client.stopping && !this.wake)
      this.wake = setTimeout(() => {
        this.wake = undefined;
        void this.sync();
      }, 0);
  }
  private forced = new Set<string>();
  private sent = new Map<string, string>();
  error?: string;
  constructor(readonly client: Client) {}
  start() {
    this.timer = setInterval(() => void this.sync(), 2500);
    this.timer.unref();
  }
  close() {
    clearTimeout(this.wake);
    clearInterval(this.timer);
    this.supported = false;
    this.sent.clear();
  }
  reset() {
    this.supported = false;
    this.sent.clear();
    this.forced.clear();
  }
  refresh(taskId: string) {
    this.forced.add(taskId);
    void this.sync();
  }
  async resources(value: Run) {
    const git = (args: string[]) =>
      run("git", ["-C", value.directory, ...args], { timeout: 5000 }).then(
        (v) => v.trim(),
      );
    const now = Date.now();
    const [environment, patch] = await Promise.allSettled([
      Promise.all([
        git(["symbolic-ref", "--quiet", "--short", "HEAD"]).catch(
          () => undefined,
        ),
        git(["rev-parse", "--verify", "HEAD"]),
      ]),
      this.client.executor.artifact(value.task.runId),
    ]);
    const resources = (value.detailResources ??= {});
    resources.environmentAt = now;
    resources.environment = {
      directory: value.directory,
      deviceName: hostname(),
      ownerName: this.client.settings.profile?.name,
      branch:
        environment.status === "fulfilled" ? environment.value[0] : undefined,
      commit:
        environment.status === "fulfilled" ? environment.value[1] : undefined,
    };
    resources.environmentError =
      environment.status === "rejected"
        ? "Gitの実行環境を取得できませんでした。"
        : undefined;
    if (patch.status === "fulfilled") {
      resources.patch = activityText(patch.value.patch, 256000);
      resources.patchAt = now;
      resources.patchError = undefined;
    } else
      resources.patchError =
        "差分を取得できませんでした。最後に取得した内容を表示しています。";
  }
  async sync() {
    const c = this.client;
    if (this.busy || !this.supported || !c.connected || c.stopping) return;
    this.busy = true;
    const generation = c.generation,
      engineUrl = c.settings.engineUrl!,
      deviceId = c.settings.deviceId!;
    const valid = () =>
      c.connected &&
      !c.stopping &&
      this.supported &&
      generation === c.generation &&
      engineUrl === c.settings.engineUrl &&
      deviceId === c.settings.deviceId;
    try {
      for (const value of Object.values(c.executor.runs)) {
        if (!valid()) break;
        const share = value.discordShare;
        if (
          c.executor.deletedTasks[value.task.id] ||
          !c.settings.projects.some((p) => p.id === value.task.projectId)
        )
          continue;
        if (
          value.origin === "local" &&
          (!share?.taskId ||
            share.engineUrl !== engineUrl ||
            share.deviceId !== deviceId ||
            share.status !== "synced")
        )
          continue;
        const taskId =
          value.origin === "local" ? share!.taskId! : value.task.id;
        const binding = value.detailSync;
        if (
          binding &&
          (binding.engineUrl !== engineUrl || binding.deviceId !== deviceId)
        )
          continue;
        try {
          const before = detailSnapshot(c, value, taskId);
          const identity = `${taskId}:${value.task.revision}`;
          const fingerprint = fingerprintOf(before);
          const force = this.forced.has(taskId);
          const active = ["assigned", "running"].includes(value.state);
          const resourceKey = `${value.task.revision}:${value.state}`;
          const resourcesNeeded =
            !this.sent.has(identity) ||
            force ||
            value.detailSync?.resourceKey !== resourceKey ||
            !value.detailResources ||
            (active &&
              Date.now() - (value.detailResources.environmentAt ?? 0) >= 5000);
          if (!resourcesNeeded && this.sent.get(identity) === fingerprint)
            continue;
          // Authorize before sending any display data, including legacy completed runs.
          const target = await c.workspaceRequest<{ sequence: number }>(
            "task.detail.target",
            { taskId, runId: value.task.runId, revision: value.task.revision },
          );
          if (!valid()) break;
          value.detailSync ??= { engineUrl, deviceId, sequence: 0 };
          value.detailSync.sequence = Math.max(
            value.detailSync.sequence,
            target.sequence,
          );
          this.forced.delete(taskId);
          if (resourcesNeeded) {
            if (!this.resourceJobs.has(value)) {
              value.detailSync.resourceKey = resourceKey;
              const job = this.resources(value)
                .then(async () => {
                  if (valid() && !c.executor.deletedTasks[value.task.id]) {
                    await c.executor.save();
                    void this.sync();
                  }
                })
                .catch(() => {
                  this.error = "DETAIL_RESOURCE_FAILED";
                })
                .finally(() => this.resourceJobs.delete(value));
              this.resourceJobs.set(value, job);
            }
          } else if (this.sent.get(identity) === fingerprint) continue;
          if (!valid() || c.executor.deletedTasks[value.task.id]) break;
          value.detailSync.sequence++;
          await c.executor.save();
          const snapshot = detailSnapshot(c, value, taskId);
          const bytes = Buffer.from(JSON.stringify(snapshot));
          if (bytes.length > 16 * 1024 * 1024)
            throw new Error("DETAIL_TOO_LARGE");
          const digest = createHash("sha256").update(bytes).digest("hex");
          const total = Math.ceil(bytes.length / CHUNK_BYTES);
          for (let index = 0; index < total; index++) {
            if (!valid()) throw new Error("CONNECTION_CHANGED");
            await c.workspaceRequest("task.detail.sync", {
              taskId,
              runId: snapshot.runId,
              revision: snapshot.revision,
              sequence: snapshot.sequence,
              digest,
              index,
              total,
              data: bytes
                .subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)
                .toString("base64"),
            });
          }
          this.sent.set(identity, fingerprintOf(snapshot));
          this.error = undefined;
        } catch (error) {
          this.error = (error as Error).message;
        }
      }
    } finally {
      this.busy = false;
    }
  }
  async read(taskId: string, projectId: string): Promise<TaskDetailRead> {
    const c = this.client;
    const generation = c.generation;
    if (!c.connected || !c.settings.projects.some((p) => p.id === projectId))
      throw new Error("PROJECT_CONNECTION_REQUIRED");
    if (!this.supported) {
      const result = await c.workspaceRequest<ProjectWorkspace>(
        "project.snapshot",
        { projectId },
      );
      const task = result.tasks.find((t) => t.id === taskId);
      if (!task) throw new Error("TASK_NOT_FOUND");
      return { task, supported: false, ownerConnected: false };
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let offset = 0,
        token: string | undefined;
      const parts: Buffer[] = [];
      try {
        do {
          const page = await c.workspaceRequest<TaskDetailPage>(
            "task.detail.read",
            { taskId, offset, token },
          );
          if (
            !c.connected ||
            c.generation !== generation ||
            !c.settings.projects.some((p) => p.id === projectId)
          )
            throw new Error("PROJECT_CONNECTION_REQUIRED");
          token = page.token;
          parts.push(Buffer.from(page.data, "base64"));
          if (parts.reduce((n, p) => n + p.length, 0) > 32 * 1024 * 1024)
            throw new Error("DETAIL_TOO_LARGE");
          if (page.nextOffset === undefined) break;
          if (page.nextOffset <= offset) throw new Error("INVALID_DETAIL");
          offset = page.nextOffset;
        } while (true);
        const result = JSON.parse(
          Buffer.concat(parts).toString(),
        ) as TaskDetailRead;
        if (result.task.id !== taskId || result.task.projectId !== projectId)
          throw new Error("TASK_NOT_FOUND");
        return result;
      } catch (error) {
        if ((error as Error).message !== "DETAIL_CHANGED" || attempt === 2)
          throw error;
      }
    }
    throw new Error("DETAIL_CHANGED");
  }
}
