import { previousRegistration } from "./participant-identity.js";
import { TaskFollowup } from "./TaskFollowup.js";
import { SharedTaskInspector } from "./SharedTaskInspector.js";
import { TaskDispatchNotice } from "./TaskDispatchNotice.js";
import type { ClientState } from "@ido/common/contracts/api";
import type { TeamTaskSnapshot } from "@ido/common/contracts/api";
import { MessageText } from "./ActivityFeed.js";
type Summary = TeamTaskSnapshot["tasks"][number];

export function TeamTaskDetail({
  task,
  local,
  stale,
  state,
  openSettings,
}: {
  task: Summary;
  local: boolean;
  stale: boolean;
  state: ClientState;
  openSettings: () => void;
}) {
  return (
    <section
      className="task-workspace with-inspector"
      aria-label="共有タスクの概要"
    >
      <div className="task-conversation">
        <div className="conversation-scroll">
          <div className="conversation-content">
            <h2>{task.title}</h2>
            {stale && (
              <p role="status">
                最新状態を取得できていません。以下は最終取得時の情報です。
              </p>
            )}
            {!task.clientId && (
              <p>実行先が決まると、このPCまたはほかのPCの一覧へ移動します。</p>
            )}
            {task.state === "queued" && !task.clientId && (
              <TaskDispatchNotice
                state={state}
                task={task}
                openSettings={openSettings}
              />
            )}
            {task.progress && <MessageText text={task.progress} />}
            <TaskFollowup key={task.id} task={task} state={state} />
            <p>
              {local
                ? "このPCへのタスク到着を待っています。"
                : "ここでは共有された進捗を確認できます。追加指示・停止はDiscordの対応スレッドから操作してください。"}
            </p>
          </div>
        </div>
      </div>
      <SharedTaskInspector
        key={task.id}
        summary={task}
        registrationLabel={
          local
            ? "このPC"
            : previousRegistration(task, state.settings)
              ? "自分の以前の登録"
              : task.clientId
                ? "ほかのPC"
                : "未割り当て"
        }
        task={state.projectTasks?.find((item) => item.id === task.id)}
      />
    </section>
  );
}
