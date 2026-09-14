import { createHash } from "node:crypto";
import { clean, type Task, type Command } from "@ido/common/contracts/protocol";
import type { Client } from "../bootstrap/client.js";
import type { Run } from "../execution/executor.js";

export async function receiveSharedLocalControl(client: Client, data: Command) {
  const value = client.executor.runs[String(data.runId)];
  const share = value?.discordShare;
  if (
    value?.origin !== "local" ||
    !share ||
    !client.connected ||
    share.engineUrl !== client.settings.engineUrl ||
    share.deviceId !== client.settings.deviceId ||
    share.taskId !== data.taskId ||
    data.generation !== client.generation ||
    !["stop", "steer"].includes(data.type) ||
    !data.id ||
    !client.settings.projects.some((p) => p.id === share.projectId)
  )
    return false;
  await client.executor.receive(
    {
      ...data,
      id: "discord-" + data.id,
      taskId: value.task.id,
      task: undefined,
      specRevision:
        data.type === "steer"
          ? Math.max(
              Number(data.specRevision) || 1,
              (value.task.specRevision ?? 1) + 1,
            )
          : data.specRevision,
    },
    [value.localMapping!],
    true,
    client.settings.slots,
    { progressMode: value.progressMode ?? "auto" },
  );
  client.emit({ v: 1, type: "ack", id: data.id });
  void client.syncLocalShares();
  return true;
}

/** Deliberate projection: never include model output, paths, patches or credentials. */
export function sharedLocalSnapshot(value: Run) {
  return {
    runId: value.task.runId,
    projectId: value.discordShare!.projectId,
    title: clean(value.task.title ?? value.task.text).slice(0, 200),
    text: clean(value.task.history[0]?.text ?? value.task.text),
    revision: value.task.revision,
    specRevision: value.task.specRevision ?? 1,
    state: value.state === "assigned" ? "running" : value.state,
    phase: value.phase,
    controlReceipts: Object.values(value.controlReceipts ?? {}).slice(-100),
  };
}

export async function syncLocalShares(this: Client) {
  if (this.stopping || this.localSharingBusy || !this.connected) return;
  this.localSharingBusy = true;
  try {
    for (const value of Object.values(this.executor.runs)) {
      if (this.stopping || !this.connected) break;
      const share = value.discordShare;
      if (value.origin !== "local" || !share) continue;
      // Never replay an old outbox into a different team or device identity.
      if (
        share.engineUrl !== this.settings.engineUrl ||
        share.deviceId !== this.settings.deviceId
      )
        continue;
      const input = sharedLocalSnapshot(value);
      const fingerprint = JSON.stringify(input);
      if (share.status === "synced" && share.fingerprint === fingerprint)
        continue;
      try {
        if (!this.localSharingSupported)
          throw new Error("ENGINE_UPDATE_REQUIRED");
        if (!this.settings.projects.some((p) => p.id === share.projectId))
          throw new Error("SHARE_PROJECT_REQUIRED");
        share.taskId =
          "local-" +
          createHash("sha256")
            .update(JSON.stringify([share.deviceId, value.task.runId]))
            .digest("hex");
        share.sequence++;
        share.status = "pending";
        await this.executor.save();
        const result = await this.workspaceRequest<Pick<Task, "id" | "runId">>(
          "task.share-local",
          { ...input, sequence: share.sequence },
        );
        if (result.runId !== value.task.runId || result.id !== share.taskId)
          throw new Error("SHARE_RESPONSE_MISMATCH");
        share.taskId = result.id;
        share.fingerprint = fingerprint;
        share.status = "synced";
        share.error = undefined;
      } catch (error) {
        share.status = "error";
        const code = (error as Error).message;
        share.error = [
          "ENGINE_UPDATE_REQUIRED",
          "SHARE_PROJECT_REQUIRED",
          "DISCORD_FORUM_REQUIRED",
          "PROJECT_INVITATION_REQUIRED",
        ].includes(code)
          ? code
          : "SHARE_RETRY_PENDING";
      }
      await this.executor.save();
    }
  } catch {
    for (const value of Object.values(this.executor.runs)) {
      if (value.discordShare?.status === "pending") {
        value.discordShare.status = "error";
        value.discordShare.error = "SHARE_RETRY_PENDING";
      }
    }
  } finally {
    this.localSharingBusy = false;
  }
}
