import { useEffect, useState } from "react";
import {
  taskProgress,
  type ClientState,
  type TeamTaskSnapshot,
  type TaskDetailRead,
} from "@ido/common/contracts/api";
import { ClientRuns } from "./ClientRuns.js";
import { TaskDispatchNotice } from "./TaskDispatchNotice.js";
import { api } from "./api.js";
type Summary = TeamTaskSnapshot["tasks"][number];

export function TeamTaskDetail({
  task,
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
    <SharedTaskDetail
      key={`${state.settings.engineUrl}:${state.settings.deviceId}:${task.id}`}
      task={task}
      state={state}
      openSettings={openSettings}
    />
  );
}
export function SharedTaskDetail({
  task,
  state,
  openSettings,
}: {
  task: Pick<Summary, "id" | "projectId" | "title" | "state" | "clientId">;
  state: ClientState;
  openSettings: () => void;
}) {
  const [detail, setDetail] = useState<TaskDetailRead>();
  const [error, setError] = useState("");
  const [refreshVersion, setRefreshVersion] = useState(0);
  const joined =
    state.connected &&
    state.settings.projects.some((p) => p.id === task.projectId);
  useEffect(() => {
    setDetail(undefined);
    setError("");
  }, [
    task.id,
    task.projectId,
    state.settings.engineUrl,
    state.settings.deviceId,
  ]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    if (!joined) {
      setDetail(undefined);
      return;
    }
    const read = async () => {
      try {
        const result = await api<TaskDetailRead>("task/detail", {
          taskId: task.id,
          projectId: task.projectId,
        });
        if (!disposed) {
          setDetail(result);
          setError("");
        }
      } catch {
        // Do not keep a formerly authorized detail on permission loss/deletion.
        if (!disposed) {
          setDetail(undefined);
          setError(
            "履歴を取得できませんでした。接続状態とプロジェクトへの参加状態を確認してください。",
          );
        }
      } finally {
        if (!disposed) timer = setTimeout(() => void read(), 2500);
      }
    };
    void read();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [
    task.id,
    task.projectId,
    joined,
    refreshVersion,
    state.settings.engineUrl,
    state.settings.deviceId,
  ]);
  const refresh = async () => {
    try {
      if (detail?.supported)
        await api("task/detail-refresh", { taskId: task.id });
      setRefreshVersion((v) => v + 1);
    } catch {
      setError("最新の詳細情報を要求できませんでした。");
    }
  };
  if (!joined)
    return <p role="status">履歴の閲覧にはチームへの接続が必要です。</p>;
  if (!detail || detail.task.id !== task.id)
    return (
      <section className="task-workspace">
        <h2>{task.title}</h2>
        <p role={error ? "alert" : "status"}>
          {error || "履歴を読み込んでいます…"}
        </p>
      </section>
    );
  const snapshot = detail.snapshot;
  const currentRevision =
    snapshot?.revision === detail.task.revision &&
    snapshot?.runId === detail.task.runId;
  const current: ClientState["runs"][number] = snapshot
    ? {
        ...snapshot.run,
        task: currentRevision
          ? {
              ...snapshot.run.task,
              clientId: detail.task.clientId,
              participants:
                detail.task.participants ?? snapshot.run.task.participants,
            }
          : detail.task,
        state: detail.task.state,
        result:
          currentRevision && snapshot.run.state === detail.task.state
            ? (snapshot.run.result ?? detail.task.result)
            : detail.task.result,
      }
    : {
        task: detail.task,
        state: detail.task.state,
        result: detail.task.result,
        directory: "",
      };
  current.contextSources ??= [
    ...(detail.task.sourceStatements ?? []).map((source, index) => ({
      id: `minutes-${index}`,
      kind: "minutes" as const,
      title: source.speakerName
        ? `議事録 · ${source.speakerName}`
        : `議事録 ${index + 1}`,
      text: source.text,
    })),
    ...(detail.task.attachedSources ?? []),
  ];
  const notice = [
    !task.clientId
      ? "実行先が決まると、このPCまたはほかのPCの一覧へ移動します。"
      : undefined,
    !snapshot
      ? taskProgress(detail.task.progress, detail.task.state)
      : undefined,
    error,
    !detail.supported
      ? "実行PCとEngineを更新すると、詳細な行動ログも表示されます。"
      : !snapshot
        ? "詳細履歴の同期待ちです。保存済みの依頼・回答を表示しています。"
        : !currentRevision
          ? "最新の実行履歴を同期しています。"
          : undefined,
    snapshot
      ? detail.ownerConnected
        ? "実行PCに接続中。"
        : "実行PCはオフラインです。最後に同期された内容を表示しています。"
      : undefined,
    detail.syncedAt
      ? `最終同期: ${new Date(detail.syncedAt).toLocaleString()}`
      : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      {task.state === "queued" && !task.clientId && (
        <TaskDispatchNotice
          state={state}
          task={detail.task}
          openSettings={openSettings}
        />
      )}
      <ClientRuns
        key={task.id}
        state={state}
        current={current}
        remote={{ detail, notice, refresh }}
        action={async () => {
          throw new Error("REMOTE_READ_ONLY");
        }}
        invoke={() => {}}
        setup={openSettings}
      />
    </>
  );
}
