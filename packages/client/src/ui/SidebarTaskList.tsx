import type { Action, ClientState } from "@ido/common-ui";
import { TaskMenu } from "@ido/common-ui";
import { stateLabel } from "./ActivityFeed.js";
import { TaskAvatars } from "./TaskAvatars.js";
import { previousRegistration } from "./participant-identity.js";
import {
  sidebarTaskState,
  sidebarTaskTitle,
  taskIndicator,
  taskReadKey,
  type SidebarTask,
} from "./sidebar-tasks.js";

export function SidebarTaskList({
  items,
  state,
  connected,
  selected,
  select,
  action,
  seen,
  scope,
}: {
  items: SidebarTask[];
  state: ClientState;
  connected: boolean;
  selected?: string;
  select: (item: SidebarTask) => void;
  action: Action;
  seen: Record<string, string>;
  scope: string;
}) {
  return (
    <div className="project-tasks">
      {items.map((item) => {
        const { task, run } = item;
        const title = sidebarTaskTitle(item);
        const indicator = taskIndicator(item, seen[taskReadKey(scope, item)]);
        const menuTask = state.projectTasks?.find(
          (candidate) => candidate.id === task.id,
        );
        const location = run
          ? "このPC"
          : previousRegistration(task, state.settings)
            ? "自分の以前の登録"
            : task.clientId === state.settings.deviceId
              ? "このPC"
              : task.clientId
                ? "ほかのPC"
                : "未割り当て";
        return (
          <div className="task-row" key={task.runId} data-task-id={task.id}>
            <button
              className={`task-link ${selected === task.runId ? "selected" : ""}`}
              disabled={!connected && run?.origin !== "local"}
              aria-current={selected === task.runId ? "page" : undefined}
              title={`${title} · ${location} · ${stateLabel(sidebarTaskState(item))}`}
              onClick={() => select(item)}
            >
              <span className="task-title">{title}</span>
              <TaskAvatars state={state} task={task} local={!!run} />
              <span className="task-indicator-slot">
                {indicator && (
                  <span
                    role="img"
                    aria-label={
                      indicator === "running" ? "実行中" : "未確認の結果"
                    }
                    className={`task-indicator ${indicator}`}
                  />
                )}
              </span>
            </button>
            {menuTask && (
              <TaskMenu
                task={menuTask}
                actorId={state.settings.deviceId}
                action={action}
                disabled={!connected || !state.lifecycleSupported}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}
