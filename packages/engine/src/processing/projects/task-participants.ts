import {
  clean,
  type Task,
  type TaskParticipant,
} from "@ido/common/contracts/protocol";
import type { Device } from "../../domain/models.js";
import type { Repository } from "../../ports/repository.js";

/** Presentation only: creator, executor and people who contributed instructions. */
export function taskParticipants(
  store: Repository,
  task: Task,
): TaskParticipant[] {
  const participants = new Map<string, TaskParticipant>();
  const add = (actorId: string | undefined, executor = false) => {
    if (!actorId) return;
    const deviceId = executor
      ? actorId
      : actorId.startsWith("client-")
        ? actorId.slice(7)
        : undefined;
    const device = deviceId ? store.get<Device>("device", deviceId) : undefined;
    if (device && !device.revoked) {
      participants.set(device.id, {
        id: device.id,
        name: clean(device.profile?.name ?? device.name).slice(0, 100),
      });
    } else if (!executor) {
      const author = store.conversationAuthor?.(actorId);
      if (author)
        participants.set(actorId, {
          id: actorId,
          name: clean(author.name).slice(0, 100),
        });
    }
  };
  add(task.clientId, true);
  add(task.authorId);
  for (const source of task.sourceStatements ?? [])
    add(source.authorId ?? source.userId);
  for (const receipt of Object.values(task.controlReceipts ?? {}))
    add(receipt.authorId);
  if (
    task.createdByBot ||
    (task.createdByBot === undefined && (task.kind || task.sourceIds?.length))
  )
    participants.set("idobot", { id: "idobot", name: "idobot", bot: true });
  return [...participants.values()];
}
