import type { ClientState } from "@ido/common/contracts/api";
import type { Task, TaskParticipant } from "@ido/common/contracts/protocol";
import { isSelf } from "./participant-identity.js";

export function taskOwner(
  state: ClientState,
  task: Pick<Task, "id"> & Partial<Task>,
  local = false,
  ownerName?: string,
): TaskParticipant | undefined {
  const id =
    task.clientId ?? (local ? (state.settings.deviceId ?? "local") : undefined);
  if (!id) return undefined;
  const summary = state.teamTasks?.tasks.find((item) => item.id === task.id);
  const participant = (
    state.projectTasks?.find((item) => item.id === task.id)?.participants ??
    task.participants ??
    summary?.participants
  )?.find((person) => person.id === id);
  const profile = state.teamTasks?.profiles?.find((person) => person.id === id);
  const person = {
    id,
    ...participant,
    ...profile,
    name:
      profile?.name ??
      participant?.name ??
      ownerName ??
      summary?.ownerName ??
      "未取得",
  };
  return isSelf(person, state.settings) || (local && id === "local")
    ? {
        ...person,
        name: state.settings.profile?.name || ownerName || "自分",
        avatar: state.settings.profile?.avatar,
      }
    : person;
}
