import { Modal, Text } from "@mantine/core";
import { Form } from "@ido/common-ui";
import { desktopBridge } from "./desktop.js";
import { useEffect, useRef, useState } from "react";
import { ClientView } from "./ClientView.js";
import { ClientRuns } from "./ClientRuns.js";
import { useRemoteState } from "./useRemoteState.js";
import { Icon } from "./Icons.js";
import { activeState, stateLabel } from "./ActivityFeed.js";
import "./workspace.css";
export function App() {
  const { state, error, refresh, action, invoke } = useRemoteState();
  const [page, setPage] = useState<"overview" | "runs">();
  const [selected, select] = useState<string>();
  const [query, search] = useState("");
  const [sidebar, showSidebar] = useState(true);
  const [projectDialog, setProjectDialog] = useState<string | undefined>();
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
            プロジェクト<span>{runs.length} タスク</span>
            <button
              className="icon-button"
              aria-label="プロジェクトを追加"
              disabled={!state.connected || !state.projectCreationSupported}
              onClick={() => setProjectDialog("")}
            >
              ＋
            </button>
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
                  {!state.settings.mappings.some((m) => m.projectId === id) && (
                    <button
                      className="icon-button"
                      aria-label="保存先を選択"
                      disabled={!state.connected}
                      onClick={() => setProjectDialog(id)}
                    >
                      ＋
                    </button>
                  )}
                </div>
                {items.map((run) => (
                  <button
                    key={run.task.runId}
                    className={`task-link ${currentPage === "runs" && run.task.runId === current?.task.runId ? "selected" : ""}`}
                    aria-current={
                      currentPage === "runs" &&
                      run.task.runId === current?.task.runId
                        ? "page"
                        : undefined
                    }
                    title={run.task.title ?? run.task.text}
                    onClick={() => {
                      select(run.task.runId);
                      setPage("runs");
                    }}
                  >
                    <span>{run.task.title ?? run.task.text}</span>
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
      <Modal
        opened={projectDialog !== undefined}
        onClose={() => setProjectDialog(undefined)}
        title={
          projectDialog ? "プロジェクトの保存先を選択" : "プロジェクトを追加"
        }
      >
        <Text size="sm" mb="md">
          コミット済みGitリポジトリ、または空フォルダを選択してください。空フォルダはGitで初期化します。実行を許可する前に保存先を設定します。
        </Text>
        <Form
          key={projectDialog}
          fields={[
            ...(!projectDialog ? [{ key: "name", label: "名前" }] : []),
            {
              key: "directory",
              label: "ディレクトリ",
              pick: desktopBridge()?.pickDirectory,
            },
          ]}
          submit={async (data) => {
            await action(projectDialog ? "mappings" : "projects", {
              ...data,
              ...(projectDialog
                ? { projectId: projectDialog, network: false, slots: 1 }
                : {}),
            });
            setProjectDialog(undefined);
          }}
          label={projectDialog ? "保存先を設定" : "追加"}
        />
      </Modal>
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
              : (current?.task.title ?? current?.task.text ?? "実行と承認")}
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
        {currentPage === "overview" ? (
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
