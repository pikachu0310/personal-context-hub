import { createHash } from "node:crypto";
import { clean, id, text, type Task } from "@ido/common/contracts/protocol";
import type { Repository } from "../../ports/repository.js";
import type { Device } from "../../domain/models.js";
import { ProjectTeam } from "../projects/team.js";
import { Tasks } from "./service.js";

/** A mirror is owned by its originating device and never enters the scheduler queue. */
export function shareLocalTask(
  store: Repository,
  deviceId: string,
  generation: number,
  input: Record<string, unknown>,
) {
  const projectId = id(input.projectId),
    runId = id(input.runId);
  new ProjectTeam(store).require(deviceId, projectId);
  const device = store.get<Device>("device", deviceId);
  if (!device || device.revoked || device.generation !== generation)
    throw new Error("STALE_CONNECTION");
  const config = store.get<Record<string, string>>("config", "discord");
  if (!config?.issueForumChannelId || config.projectId !== projectId)
    throw new Error("DISCORD_FORUM_REQUIRED");
  for (const field of ["sequence", "revision", "specRevision"])
    if (!Number.isSafeInteger(input[field]) || Number(input[field]) < 1)
      throw new Error("INVALID_REVISION");
  if (
    !["running", "interrupted", "completed", "failed", "cancelled"].includes(
      String(input.state),
    )
  )
    throw new Error("INVALID_STATE");
  const taskId = `local-${createHash("sha256")
    .update(JSON.stringify([deviceId, runId]))
    .digest("hex")}`;
  return store.transaction(() => {
    let task = store.get<Task>("task", taskId);
    if (
      task &&
      (task.clientId !== deviceId ||
        task.projectId !== projectId ||
        !task.localMirror)
    )
      throw new Error("SHARE_TARGET_MISMATCH");
    if (task && Number(input.sequence) <= task.localMirror!.sequence)
      return { id: task.id, runId };
    if (task && Number(input.revision) < task.revision)
      throw new Error("STALE_REVISION");
    if (!task) {
      task = {
        id: taskId,
        runId,
        projectId,
        meetingId: `local-${projectId}`,
        authorId: `client-${deviceId}`,
        requestId: runId,
        text: clean(text(input.text)),
        title: clean(text(input.title, 200)),
        clientId: deviceId,
        revision: Number(input.revision),
        specRevision: 1,
        network: false,
        state: "assigned",
        history: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        localMirror: { deviceId, runId, sequence: 0 },
      };
      store.audit(task.authorId, "task.share-local", taskId);
    }
    if (Number(input.revision) > task.revision) {
      task.revision = Number(input.revision);
      task.state = "assigned";
      task.result = undefined;
    }
    task.specRevision = Math.max(
      task.specRevision ?? 1,
      Number(input.specRevision),
    );
    task.localMirror!.sequence = Number(input.sequence);
    store.put("task", task.id, task);
    const progress =
      input.state === "running"
        ? input.phase === "planning"
          ? "相談・計画中"
          : input.phase === "awaiting-plan"
            ? "実行の指示待ち"
            : "このPCで実行中"
        : (
            {
              completed: "完了",
              failed: "失敗（詳細は作成者のアプリで確認）",
              cancelled: "停止済み",
              interrupted: "中断中",
            } as Record<string, string>
          )[String(input.state)];
    new Tasks(store).applyResult(deviceId, generation, {
      v: 1,
      type: "result",
      taskId,
      runId,
      revision: task.revision,
      state: input.state,
      progress,
      specRevision: Number(input.specRevision),
      controlReceipts: input.controlReceipts,
    });
    return { id: task.id, runId };
  });
}
