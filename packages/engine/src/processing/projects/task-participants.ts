import {
  clean,
  type Task,
  type TaskParticipant,
} from "@ido/common/contracts/protocol";
import type { Device } from "../../domain/models.js";
import type { Repository } from "../../ports/repository.js";

/** Legacy participants are imported once; explicit exits always win. */
function inferredParticipants(
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

export const participantId = (actor: string) =>
  actor.startsWith("client-") ? actor.slice(7) : actor;
export function seedParticipants(store: Repository, task: Task) {
  if (task.memberStates !== undefined) return;
  task.memberStates = Object.fromEntries(
    inferredParticipants(store, task)
      .filter((p) => !p.bot)
      .map((p) => [p.id, true]),
  );
  task.membershipVersion = 0;
}
export function addParticipant(store: Repository, task: Task, actor: string) {
  seedParticipants(store, task);
  const key = participantId(actor);
  if (task.memberStates![key] === undefined) {
    task.memberStates![key] = true;
    task.membershipVersion = (task.membershipVersion ?? 0) + 1;
  }
}
export function taskParticipants(
  store: Repository,
  task: Task,
): TaskParticipant[] {
  if (!task.memberStates) return inferredParticipants(store, task);
  const inferred = inferredParticipants(store, task);
  return [
    ...Object.entries(task.memberStates)
      .filter(([, joined]) => joined)
      .map(([id]) => {
        const device = store.get<Device>("device", id);
        return {
          id,
          name: clean(
            device?.profile?.name ??
              device?.name ??
              inferred.find((p) => p.id === id)?.name ??
              store.conversationAuthor(id)?.name ??
              "参加者",
          ).slice(0, 100),
        };
      }),
    ...inferred.filter((p) => p.bot),
  ];
}
export function taskBusy(task: Task) {
  return (
    ["assigned", "running", "interrupted"].includes(task.state) ||
    Object.values(task.controlReceipts ?? {}).some(
      (r) => r.type === "stop" && !["stopped", "rejected"].includes(r.delivery),
    )
  );
}
