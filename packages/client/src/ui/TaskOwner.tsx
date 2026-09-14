import type { ClientState } from "@ido/common/contracts/api";
import type { Task } from "@ido/common/contracts/protocol";
import { UserAvatar } from "./TaskAvatars.js";
import { taskOwner } from "./task-owner.js";

export function TaskOwner({
  state,
  task,
  local,
  ownerName,
}: {
  state: ClientState;
  task: Pick<Task, "id"> & Partial<Task>;
  local?: boolean;
  ownerName?: string;
}) {
  const person = taskOwner(state, task, local, ownerName);
  return person ? (
    <span className="task-owner">
      <UserAvatar person={person} />
      <span>{person.name}</span>
    </span>
  ) : (
    <span>未割り当て</span>
  );
}
