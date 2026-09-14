import { useEffect, useRef, useState } from "react";
import { ClientView } from "./ClientView.js";
import { ClientRuns } from "./ClientRuns.js";
import { TeamTaskDetail } from "./TeamTasks.js";
import { NewLocalTask } from "./NewLocalTask.js";
import { useRemoteState } from "./useRemoteState.js";
import { Icon } from "./Icons.js";
import { activeState, stateLabel } from "./ActivityFeed.js";
import "./workspace.css";
export function App() {
  const { state, error, refresh, action, invoke } = useRemoteState();
  const [page, setPage] = useState<"overview" | "runs" | "new-local">();
  const [selected, select] = useState<string>();
  const [selectedShared, selectShared] = useState<string>();
  const [query, search] = useState("");
  const [sidebar, showSidebar] = useState(true);
  const wasConnected = useRef(false);
  useEffect(() => {
    if (state?.connected && !wasConnected.current) setPage("runs");
    wasConnected.current = state?.connected ?? false;
  }, [state?.connected]);
  useEffect(() => {
    if (!selected && state?.runs.length)
      select(
        state.runs.find((run) => activeState(run.state))?.task.runId ??
          state.runs[0].task.runId,
      );
  }, [selected, state?.runs]);
  useEffect(() => {
    const task = state?.teamTasks?.tasks.find(
      (task) => task.id === selectedShared,
    );
    if (
      state &&
      task &&
      task.clientId === state?.settings.deviceId &&
      state.runs.some((run) => run.task.runId === task.runId)
    ) {
      select(task.runId);
      selectShared(undefined);
    }
  }, [selectedShared, state]);
  if (!state)
    return (
      <div className="workspace-loading">
        {error || "IDO Agentを準備しています…"}
      </div>
    );
  const currentPage = page ?? (state.settings.deviceId ? "runs" : "overview");
  const runs = [...state.runs].sort(
    (a, b) =>
      Number(activeState(b.state)) - Number(activeState(a.state)) ||
      (b.updatedAt ?? b.task.updatedAt) - (a.updatedAt ?? a.task.updatedAt),
  );
  const current = runs.find((run) => run.task.runId === selected) ?? runs[0];
  const shared = state.connected ? (state.teamTasks?.tasks ?? []) : [];
  const sharedCurrent = shared.find((task) => task.id === selectedShared);
  const sharedStale =
    !!state.teamTasks && Date.now() - state.teamTasks.updatedAt > 15000;
  const sharedGroups = [
    {
      name: "このPC · 受け取り待ち",
      tasks: shared.filter(
        (task) =>
          task.clientId === state.settings.deviceId &&
          !runs.some((run) => run.task.runId === task.runId),
      ),
    },
    {
      name: "ほかのPC",
      tasks: shared.filter(
        (task) => task.clientId && task.clientId !== state.settings.deviceId,
      ),
    },
    { name: "未割り当て", tasks: shared.filter((task) => !task.clientId) },
  ];
  const filtered = runs.filter((run) =>
    `${run.task.title ?? ""} ${run.task.text}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const projects = [
    ...new Set([
      ...state.settings.projects.map((p) => p.id),
      ...runs.map((r) => r.task.projectId),
    ]),
  ];
  return (
    <div className={`agent-workspace ${sidebar ? "" : "sidebar-hidden"}`}>
      <aside className="workspace-sidebar" aria-label="プロジェクトとタスク">
        <div className="sidebar-brand">
          <span className="brand-symbol">i</span>
          <strong>IDO Agent</strong>
          <button
            className="icon-button"
            aria-label="サイドバーを閉じる"
            onClick={() => showSidebar(false)}
          >
            <Icon name="panel" />
          </button>
        </div>
        <nav className="sidebar-nav" aria-label="メインメニュー">
          <button
            className={currentPage === "new-local" ? "nav-active" : ""}
            onClick={() => setPage("new-local")}
          >
            <Icon name="terminal" />
            新しいローカルタスク
          </button>
          <button
            className={currentPage === "runs" ? "nav-active" : ""}
            onClick={() => setPage("runs")}
          >
            <Icon name="terminal" />
            実行と承認
            {state.approvals.length > 0 && (
              <span className="count-badge">{state.approvals.length}</span>
            )}
          </button>
          <button
            className={currentPage === "overview" ? "nav-active" : ""}
            onClick={() => setPage("overview")}
          >
            <Icon name="settings" />
            接続とセットアップ
          </button>
        </nav>
        <label className="task-search">
          <Icon name="search" size={16} />
          <input
            aria-label="タスクを検索"
            placeholder="タスクを検索"
            value={query}
            onChange={(e) => search(e.currentTarget.value)}
          />
        </label>
        <div className="project-list">
          <div className="sidebar-caption">
            このPC<span>{runs.length} タスク</span>
          </div>
          {projects.map((id) => {
            const items = filtered.filter((r) => r.task.projectId === id);
            if (query && !items.length) return null;
            return (
              <section key={id} className="project-group">
                <div className="project-name">
                  <Icon name="folder" size={16} />
                  <span>
                    {state.settings.projects.find((p) => p.id === id)?.name ??
                      "ローカルプロジェクト"}
                  </span>
                </div>
                {items.map((run) => (
                  <button
                    key={run.task.runId}
                    className={`task-link ${!selectedShared && currentPage === "runs" && run.task.runId === current?.task.runId ? "selected" : ""}`}
                    aria-current={
                      currentPage === "runs" &&
                      !selectedShared &&
                      run.task.runId === current?.task.runId
                        ? "page"
                        : undefined
                    }
                    title={run.task.title ?? run.task.text}
                    onClick={() => {
                      select(run.task.runId);
                      selectShared(undefined);
                      setPage("runs");
                    }}
                  >
                    <span>
                      {run.task.title ?? run.task.text}
                      {run.origin === "local" && (
                        <small className="shared-task-owner">
                          {run.agent === "claude" ? "Claude Code" : "Codex"} ·
                          ローカルで開始 · Bot未共有
                        </small>
                      )}
                    </span>
                    <span
                      role="img"
                      aria-label={stateLabel(run.state)}
                      className={`task-dot ${activeState(run.state) ? "active" : run.state}`}
                    />
                  </button>
                ))}
              </section>
            );
          })}
          {!filtered.length && (
            <p className="sidebar-empty">
              {query
                ? "一致するタスクはありません"
                : "Discordから依頼すると、ここにタスクが表示されます。"}
            </p>
          )}
          {sharedGroups.map((group) => (
            <section key={group.name} aria-label={group.name}>
              <div className="sidebar-caption">
                {group.name}
                <span>{group.tasks.length} タスク</span>
              </div>
              {group.tasks
                .filter((task) =>
                  `${task.title} ${task.ownerName ?? ""} ${task.deviceName ?? ""}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                )
                .map((task) => (
                  <button
                    key={task.id}
                    className={`task-link ${currentPage === "runs" && selectedShared === task.id ? "selected" : ""}`}
                    aria-current={
                      currentPage === "runs" && selectedShared === task.id
                        ? "page"
                        : undefined
                    }
                    title={`${task.title} · ${task.ownerName ?? "未割り当て"} · ${stateLabel(task.state)}`}
                    onClick={() => {
                      selectShared(task.id);
                      setPage("runs");
                    }}
                  >
                    <span>
                      {task.title}
                      <small className="shared-task-owner">
                        {task.ownerName ||
                          (task.clientId ? "担当不明" : "実行待ち")}{" "}
                        · {stateLabel(task.state)}
                      </small>
                    </span>
                    <span
                      className={`task-dot ${activeState(task.state) && !sharedStale && task.deviceConnected ? "active" : task.state}`}
                    />
                  </button>
                ))}
            </section>
          ))}
          <p className="sidebar-empty" role="status">
            {!state.connected
              ? "ほかのPCの状態を見るには接続してください。"
              : !state.teamTasksSupported
                ? "チーム一覧にはEngineの更新が必要です。"
                : !state.teamTasks
                  ? "チームのタスクを取得中…"
                  : sharedStale
                    ? "共有情報の更新が遅れています。"
                    : `共有情報 ${new Date(state.teamTasks.updatedAt).toLocaleTimeString()}`}
          </p>
          {state.teamTasks &&
            state.teamTasks.total > state.teamTasks.tasks.length && (
              <p className="sidebar-empty">
                チームの全{state.teamTasks.total}件中、進行中を優先して
                {state.teamTasks.tasks.length}件表示しています。
              </p>
            )}
        </div>
        <footer className="sidebar-footer">
          <div className="local-avatar">PC</div>
          <div>
            <strong>このPCのエージェント</strong>
            <span>
              <i
                className={`connection-dot ${state.connected ? "online" : ""}`}
              />
              {state.connected ? "チームに接続中" : "オフライン"}
            </span>
          </div>
          <button
            className="icon-button"
            aria-label="接続設定を開く"
            onClick={() => setPage("overview")}
          >
            <Icon name="settings" size={17} />
          </button>
        </footer>
      </aside>
      <main className="workspace-main">
        <header className="workspace-header">
          <button
            className="icon-button"
            aria-label="サイドバーの表示を切り替える"
            onClick={() => showSidebar(!sidebar)}
          >
            <Icon name="panel" />
          </button>
          <Icon name="folder" size={17} />
          <h1>
            {currentPage === "overview"
              ? "接続とセットアップ"
              : currentPage === "new-local"
                ? "新しいローカルタスク"
                : (sharedCurrent?.title ??
                  (selectedShared
                    ? "共有タスク"
                    : (current?.task.title ?? current?.task.text)) ??
                  "実行と承認")}
          </h1>
          <button
            className="icon-button"
            aria-label="最新の状態に更新"
            onClick={() => void refresh()}
          >
            <Icon name="refresh" size={17} />
          </button>
        </header>
        {error && (
          <div className="workspace-error" role="alert">
            {error}
          </div>
        )}
        {currentPage === "new-local" ? (
          <NewLocalTask
            action={action}
            mode={state.settings.progressMode ?? "auto"}
            started={(runId) => {
              select(runId);
              selectShared(undefined);
              setPage("runs");
            }}
          />
        ) : currentPage === "overview" ? (
          <div className="setup-scroll">
            <div className="setup-content">
              <div className="setup-intro">
                <span>YOUR LOCAL WORKSPACE</span>
                <h2>
                  チームにつないで、
                  <br />
                  このPCで作業する。
                </h2>
                <p>
                  アカウントと作業フォルダーを確認したら、タスクの準備は完了です。
                </p>
              </div>
              <ClientView
                page="overview"
                state={state}
                action={action}
                invoke={invoke}
              />
            </div>
          </div>
        ) : selectedShared ? (
          sharedCurrent ? (
            <TeamTaskDetail
              task={sharedCurrent}
              local={sharedCurrent.clientId === state.settings.deviceId}
              stale={sharedStale}
            />
          ) : (
            <div className="empty-workspace">
              <p>
                共有タスクの情報を取得できません。接続状態と最新の一覧を確認してください。
              </p>
            </div>
          )
        ) : (
          <ClientRuns
            key={current?.task.runId ?? "empty"}
            state={state}
            current={current}
            action={action}
            invoke={invoke}
            setup={() => setPage("overview")}
          />
        )}
      </main>
    </div>
  );
}
