import { Icon } from "./Icons.js";
import type { ClientState } from "@ido/common/contracts/api";
import type { Task, TaskParticipant } from "@ido/common/contracts/protocol";
import { isSelf, participantGroups } from "./participant-identity.js";

export function UserAvatar({ person }: { person: TaskParticipant }) {
  return (
    <span
      className={`user-avatar ${person.bot ? "bot-avatar" : ""}`}
      title={person.name}
    >
      {person.avatar ? (
        <img src={person.avatar} alt="" />
      ) : person.bot ? (
        <Icon name="bot" size={20} />
      ) : (
        person.name.slice(0, 2)
      )}
    </span>
  );
}
export function TaskAvatars({
  state,
  task,
  local = false,
}: {
  state: ClientState;
  task: Pick<Task, "id"> & Partial<Task>;
  local?: boolean;
}) {
  const summary = state.teamTasks?.tasks.find((t) => t.id === task.id);
  const people = new Map<string, TaskParticipant>();
  const authoritative =
    state.projectTasks?.find((t) => t.id === task.id)?.participants ??
    task.participants ??
    summary?.participants;
  for (const person of authoritative ?? []) people.set(person.id, person);
  if (
    authoritative === undefined &&
    (local ||
      (state.settings.deviceId && task.clientId === state.settings.deviceId))
  ) {
    const id = state.settings.deviceId ?? "local";
    people.set(id, {
      id,
      identityId: state.settings.identityId,
      name: state.settings.profile?.name || "自分",
      avatar: state.settings.profile?.avatar,
    });
  } else if (
    authoritative === undefined &&
    !people.size &&
    (summary?.ownerName || task.clientId)
  ) {
    const id = task.clientId ?? summary?.clientId ?? "unknown";
    people.set(id, { id, name: summary?.ownerName ?? "担当者" });
  }
  if (
    task.createdByBot ||
    (task.createdByBot === undefined && (task.kind || task.sourceIds?.length))
  )
    people.set("idobot", { id: "idobot", name: "idobot", bot: true });
  const participants = participantGroups([...people.values()]).map(
    ([person]) => ({
      ...person,
      ...(state.teamTasks?.profiles?.find((p) => p.id === person.id) ?? {}),
      ...(isSelf(person, state.settings)
        ? {
            name: state.settings.profile?.name || "自分",
            avatar: state.settings.profile?.avatar,
          }
        : {}),
    }),
  );
  if (!participants.length) return null;
  return (
    <span
      className="task-avatars"
      role="img"
      aria-label={`参加者: ${participants.map((p) => p.name).join("、")}`}
      title={participants.map((p) => p.name).join("、")}
    >
      {participants.slice(0, 3).map((person) => (
        <UserAvatar key={person.id} person={person} />
      ))}
      {participants.length > 3 && (
        <span className="user-avatar avatar-overflow">
          +{participants.length - 3}
        </span>
      )}
    </span>
  );
}
