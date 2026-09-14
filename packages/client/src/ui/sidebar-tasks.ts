import type { ClientState, TeamTaskSnapshot } from "@ido/common/contracts/api";
import type { Task } from "@ido/common/contracts/protocol";

export interface SidebarTask {
  task: Task | TeamTaskSnapshot["tasks"][number];
  run?: ClientState["runs"][number];
}

/** Prefer the local execution, then the shared summary, without duplicating a shared local task. */
export function sidebarTasks(state: ClientState): SidebarTask[] {
  const items: SidebarTask[] = state.runs.map((run) => ({
    task: run.task,
    run,
  }));
  const ids = new Set(
    items.flatMap(({ task, run }) =>
      [task.id, run?.discordShare?.taskId].filter(Boolean),
    ),
  );
  const runIds = new Set(items.map(({ task }) => task.runId));
  for (const task of [
    ...(state.connected ? (state.teamTasks?.tasks ?? []) : []),
    ...(state.projectTasks ?? []),
  ]) {
    if (ids.has(task.id) || runIds.has(task.runId)) continue;
    items.push({ task });
    ids.add(task.id);
    runIds.add(task.runId);
  }
  return items.sort(
    (a, b) =>
      (b.run?.updatedAt ?? b.task.updatedAt) -
      (a.run?.updatedAt ?? a.task.updatedAt),
  );
}

export const sidebarTaskState = (item: SidebarTask) =>
  item.run?.state ?? item.task.state;
export const sidebarTaskTitle = (item: SidebarTask) =>
  item.task.title || ("text" in item.task ? item.task.text : "タスク");
export function completionVersion(item: SidebarTask): string | undefined {
  const status = sidebarTaskState(item);
  if (!["completed", "failed", "cancelled", "interrupted"].includes(status))
    return;
  return `${item.task.runId}:${item.task.revision}:${status}`;
}
export function taskIndicator(
  item: SidebarTask,
  seen?: string,
): "running" | "unread" | undefined {
  if (["running", "in_progress"].includes(sidebarTaskState(item)))
    return "running";
  const version = completionVersion(item);
  return version && version !== seen ? "unread" : undefined;
}
export function taskReadKey(scope: string, item: SidebarTask): string {
  return JSON.stringify([scope, item.task.projectId, item.task.runId]);
}
