import type { ClientState } from "@ido/common/contracts/api";
import type { Task, TaskParticipant } from "@ido/common/contracts/protocol";

export function UserAvatar({ person }: { person: TaskParticipant }) {
  return (
    <span
      className={`user-avatar ${person.bot ? "bot-avatar" : ""}`}
      title={person.name}
    >
      {person.avatar ? (
        <img src={person.avatar} alt="" />
      ) : person.bot ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          aria-hidden="true"
        >
          <path d="M12 3v3M9 3h6M5 8h14v11H5zM2 11v5m20-5v5M8 15h8" />
          <circle cx="9" cy="11" r="1" />
          <circle cx="15" cy="11" r="1" />
        </svg>
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
  for (const person of summary?.participants ?? task.participants ?? [])
    people.set(person.id, person);
  if (
    local ||
    (state.settings.deviceId && task.clientId === state.settings.deviceId)
  ) {
    const id = state.settings.deviceId ?? "local";
    people.set(id, {
      id,
      name: state.settings.profile?.name || "自分",
      avatar: state.settings.profile?.avatar,
    });
  } else if (!people.size && (summary?.ownerName || task.clientId)) {
    const id = task.clientId ?? summary?.clientId ?? "unknown";
    people.set(id, { id, name: summary?.ownerName ?? "担当者" });
  }
  if (
    task.createdByBot ||
    (task.createdByBot === undefined && (task.kind || task.sourceIds?.length))
  )
    people.set("idobot", { id: "idobot", name: "idobot", bot: true });
  const participants = [...people.values()].map((person) => ({
    ...person,
    ...(state.teamTasks?.profiles?.find((p) => p.id === person.id) ?? {}),
    ...(person.id === state.settings.deviceId
      ? {
          name: state.settings.profile?.name || "自分",
          avatar: state.settings.profile?.avatar,
        }
      : {}),
  }));
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
