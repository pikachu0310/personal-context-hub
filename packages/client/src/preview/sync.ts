import type { Client } from "../bootstrap/client.js";
import { inspectImplementation, git } from "./repository.js";

export class ImplementationSync {
  supported = false;
  private busy = false;
  private timer?: NodeJS.Timeout;
  private abort = new AbortController();
  constructor(readonly client: Client) {}
  start() {
    this.timer = setInterval(() => void this.sync(), 15_000);
    this.timer.unref();
  }
  close() {
    clearInterval(this.timer);
    this.abort.abort();
  }
  async sync() {
    const c = this.client;
    if (this.busy || !this.supported || !c.connected || c.stopping) return;
    this.busy = true;
    const engine = c.settings.engineUrl,
      generation = c.generation;
    try {
      for (const value of Object.values(c.executor.runs)) {
        if (
          c.stopping ||
          !c.connected ||
          c.generation !== generation ||
          c.settings.engineUrl !== engine
        )
          break;
        if (
          value.state !== "completed" ||
          c.executor.deletedTasks[value.task.id]
        )
          continue;
        const share = value.discordShare;
        const taskId =
          value.origin === "local"
            ? share?.status === "synced" &&
              share.engineUrl === engine &&
              share.deviceId === c.settings.deviceId
              ? share.taskId
              : undefined
            : value.task.id;
        if (
          !taskId ||
          !c.settings.projects.some((p) => p.id === value.task.projectId)
        )
          continue;
        const revision = value.task.revision;
        const info = await inspectImplementation(value.directory, (args) =>
          git(args, this.abort.signal),
        ).catch(() => ({ availability: "unavailable" }));
        if (
          c.stopping ||
          !c.connected ||
          c.generation !== generation ||
          c.settings.engineUrl !== engine ||
          value.task.revision !== revision ||
          value.state !== "completed"
        )
          continue;
        await c
          .workspaceRequest("implementations.sync", {
            ...info,
            taskId,
            runId: value.task.runId,
            revision,
          })
          .catch(() => {});
      }
    } finally {
      this.busy = false;
    }
  }
}
