import type { ClientActivity, ClientState } from "@ido/common/contracts/api";
import type { Task, TaskParticipant } from "@ido/common/contracts/protocol";
import { isSelf } from "./participant-identity.js";

export function initialSender(
  task: Task,
  local: boolean,
  state: ClientState,
): TaskParticipant | undefined {
  if (
    task.createdByBot ||
    (task.createdByBot === undefined && (task.kind || task.sourceIds?.length))
  )
    return { id: "idobot", name: "IDObot", bot: true };
  const id = task.authorId?.replace(/^client-/, "");
  return (
    task.participants?.find((person) => person.id === id) ??
    state.projectTasks
      ?.find((item) => item.id === task.id)
      ?.participants?.find((person) => person.id === id) ??
    (local || id === state.settings.deviceId
      ? {
          id: state.settings.deviceId ?? "local",
          identityId: state.settings.identityId,
          name: state.settings.profile?.name || "自分",
          avatar: state.settings.profile?.avatar,
        }
      : undefined)
  );
}

export function displaySender(
  sender: TaskParticipant | undefined,
  state: ClientState,
): TaskParticipant | undefined {
  if (!sender) return undefined;
  const profile = state.teamTasks?.profiles?.find(
    (person) => person.id === sender.id,
  );
  return {
    ...sender,
    ...(profile ?? {}),
    ...(isSelf(sender, state.settings)
      ? {
          name: state.settings.profile?.name || "自分",
          avatar: state.settings.profile?.avatar,
        }
      : {}),
  };
}

export const isStart = (entry: ClientActivity) =>
  entry.kind === "status" &&
  (entry.event === "started" ||
    ["作業を開始", "相談を開始"].includes(entry.title));

export function showStart(
  entry: ClientActivity,
  initialAt: number | undefined,
  entries: ClientActivity[],
) {
  if (!isStart(entry)) return true;
  // Old retries lack a reliable request timestamp. Do not compare them to the
  // original task creation time or to an unrelated instruction.
  if (entry.id.includes(":instruction-start:"))
    return (
      entry.requestAt === undefined || entry.at - entry.requestAt >= 60_000
    );
  const continuation = entries.find(
    (item) =>
      item.revision === entry.revision && item.id.includes(":continuation:"),
  );
  const sentAt =
    entry.requestAt ??
    continuation?.sentAt ??
    (entry.revision === 1 ? initialAt : undefined);
  return (
    sentAt === undefined ||
    !Number.isFinite(sentAt) ||
    entry.at - sentAt >= 60_000
  );
}
