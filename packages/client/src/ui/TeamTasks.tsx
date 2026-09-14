import { TaskDispatchNotice } from "./TaskDispatchNotice.js";
import type { ClientState } from "@ido/common/contracts/api";
import type { TeamTaskSnapshot } from "@ido/common/contracts/api";
import { MessageText, stateLabel } from "./ActivityFeed.js";
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
    <section className="task-workspace" aria-label="共有タスクの概要">
      <div className="task-topline">
        <span>
          {local ? "このPC" : task.clientId ? "ほかのPC" : "未割り当て"}
        </span>
        <span>{stateLabel(task.state)}</span>
      </div>
      <div className="conversation-scroll">
        <div className="conversation-content">
          <h2>{task.title}</h2>
          {stale && (
            <p role="status">
              最新状態を取得できていません。以下は最終取得時の情報です。
            </p>
          )}
          <p>
            {task.clientId
              ? `担当: ${task.ownerName || "不明"} · ${task.deviceName || "端末名不明"} · ${task.deviceConnected ? "接続中" : "オフライン"}`
              : "実行先が決まると、このPCまたはほかのPCの一覧へ移動します。"}
          </p>
          {task.state === "queued" && !task.clientId && (
            <TaskDispatchNotice
              state={state}
              task={task}
              openSettings={openSettings}
            />
          )}
          <p>
            最終更新: {new Date(task.updatedAt).toLocaleString()} · 実行{" "}
            {task.revision}
          </p>
          {task.progress && <MessageText text={task.progress} />}
          <p>
            {local
              ? "このPCへのタスク到着を待っています。"
              : "ここでは共有された進捗を確認できます。追加指示・停止はDiscordの対応スレッドから操作してください。"}
          </p>
        </div>
      </div>
    </section>
  );
}
