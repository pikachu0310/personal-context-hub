import { Collapsible } from "./Collapsible.js";
import { SidebarTaskList } from "./SidebarTaskList.js";
import { sidebarTasks, sidebarTaskTitle } from "./sidebar-tasks.js";
import { useTaskReadState, TaskReadObserver } from "./useTaskReadState.js";
import { api } from "./api.js";
import type {
  ProjectWorkspace,
  TaskReference,
} from "@ido/common/contracts/api";
import { NewLocalTask } from "./NewLocalTask.js";
import { ProfileSettings } from "./ProfileSettings.js";
import { TaskAvatars, UserAvatar } from "./TaskAvatars.js";
import { ProjectTaskDraft } from "./ProjectTaskDraft.js";
import { ProjectSettings } from "./ProjectSettings.js";
import { ProjectView } from "./ProjectView.js";
import { ProjectMenu } from "./ProjectMenu.js";
import { InviteDialog } from "./InviteDialog.js";
import { Modal, Text, Button, Anchor } from "@mantine/core";
import { TaskMenu } from "@ido/common-ui";
import { AddProjectForm } from "./ProjectForm.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { ClientView } from "./ClientView.js";
import { ClientRuns } from "./ClientRuns.js";
import { TeamTaskDetail } from "./TeamTasks.js";
import { useRemoteState } from "./useRemoteState.js";
import { Icon } from "./Icons.js";
import { activeState } from "./ActivityFeed.js";
import "./workspace.css";
export function App() {
  const { state, error, refresh, action, invoke } = useRemoteState();
  const { seen, markRead } = useTaskReadState();
  const dirtyMinutes = useRef(new Set<string>());
  const dirtyChanged = useCallback((id: string, dirty: boolean) => {
    if (dirty) dirtyMinutes.current.add(id);
    else dirtyMinutes.current.delete(id);
  }, []);
  const confirmNavigation = () =>
    !dirtyMinutes.current.size ||
    window.confirm("未保存の議事録を破棄して移動しますか？");
  const [linkError, setLinkError] = useState("");
  const openingLink = useRef(0);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (dirtyMinutes.current.size) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", leave);
    return () => window.removeEventListener("beforeunload", leave);
  }, []);
  const [page, setPage] = useState<"overview" | "runs">();
  const [selected, select] = useState<string>();
  const [selectedShared, selectShared] = useState<string>();
  const [query, search] = useState("");
  const [sidebar, showSidebar] = useState(true);
  const [projectDialog, setProjectDialog] = useState<string | undefined>();
  const [profileDialog, showProfile] = useState(false);
  const [localTaskProject, setLocalTaskProject] = useState<string>();
  const [settingsProject, setSettingsProject] = useState<string>();
  const [taskDrafts, setTaskDrafts] = useState<
    Record<string, { text: string; requestId: string; sentText?: string }>
  >({});
  const [projectView, setProjectView] = useState<{
    projectId: string;
    taskId?: string;
    draft?: boolean;
  }>();
  const [invite, setInvite] = useState<{ engineUrl: string; token: string }>();
  const [dismissedInvite, dismissInvite] = useState("");
  useEffect(() => {
    const url = new URL(location.href);
    const token = url.searchParams.get("projectInvite"),
      engineUrl = url.searchParams.get("engine");
    if (token && engineUrl) setInvite({ token, engineUrl });
  }, []);
  useEffect(() => {
    if (
      state?.suggestedInvite &&
      state.suggestedInvite.token !== dismissedInvite
    )
      setInvite(state.suggestedInvite);
  }, [state?.suggestedInvite?.token, dismissedInvite]);
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
  useEffect(() => {
    const local = state?.runs.find(
      (run) => run.task.id === projectView?.taskId,
    );
    if (local) {
      select(local.task.runId);
      selectShared(undefined);
      setPage("runs");
      setProjectView(undefined);
    }
  }, [projectView?.taskId, state?.runs]);
  useEffect(() => {
    if (!state) return;
    if (
      projectView &&
      !state.settings.projects.some((p) => p.id === projectView.projectId)
    )
      setProjectView(undefined);
    if (selected && !state.runs.some((r) => r.task.runId === selected))
      select(undefined);
    if (
      selectedShared &&
      !state.teamTasks?.tasks.some((t) => t.id === selectedShared)
    )
      selectShared(undefined);
  }, [state, projectView, selected, selectedShared]);
  const openMinutesTask = async (reference: TaskReference) => {
    const request = ++openingLink.current;
    setLinkError("");
    try {
      const workspace = await api<ProjectWorkspace>("project/snapshot", {
        projectId: reference.projectId,
      });
      if (request !== openingLink.current) return;
      if (
        !workspace.tasks.some(
          (task) =>
            task.id === reference.taskId &&
            task.projectId === reference.projectId,
        )
      )
        throw new Error(
          "タスクは削除されたか、このプロジェクトから参照できません。",
        );
      if (
        !state?.settings.projects.some(
          (project) => project.id === reference.projectId,
        )
      )
        throw new Error(
          "プロジェクトの一覧を更新してから、もう一度リンクを開いてください。",
        );
      if (!confirmNavigation()) return;
      dirtyMinutes.current.clear();
      setProjectView(reference);
      selectShared(undefined);
      setPage("runs");
    } catch (e) {
      if (request === openingLink.current) setLinkError((e as Error).message);
    }
  };
  if (!state)
    return (
      <div className="workspace-loading">
        {error || "IDO Agentを準備しています…"}
      </div>
    );
  const runs = [...state.runs].sort(
    (a, b) =>
      Number(activeState(b.state)) - Number(activeState(a.state)) ||
      (b.updatedAt ?? b.task.updatedAt) - (a.updatedAt ?? a.task.updatedAt),
  );
  const current = runs.find((run) => run.task.runId === selected) ?? runs[0];
  const shared = state.connected ? (state.teamTasks?.tasks ?? []) : [];
  const sharedCurrent = shared.find((task) => task.id === selectedShared);
  const activeProjectId =
    projectView?.projectId ??
    sharedCurrent?.projectId ??
    current?.task.projectId;
  const localWorkspace =
    !projectView && !selectedShared && current?.origin === "local";
  const workspaceConnected =
    localWorkspace ||
    (state.connected &&
      (!activeProjectId ||
        state.settings.projects.some((p) => p.id === activeProjectId)));
  const currentPage = !workspaceConnected ? "overview" : (page ?? "runs");
  const sharedStale =
    !!state.teamTasks && Date.now() - state.teamTasks.updatedAt > 15000;
  const allTasks = sidebarTasks(state);
  const filtered = allTasks.filter((item) =>
    [
      sidebarTaskTitle(item),
      "text" in item.task ? item.task.text : item.task.ownerName,
      "deviceName" in item.task ? item.task.deviceName : "",
    ]
      .join(" ")
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const readScope = JSON.stringify([
    state.settings.engineUrl ?? "local",
    state.settings.identityId ?? state.settings.deviceId ?? "local",
  ]);
  const viewedTask =
    currentPage !== "runs" ||
    projectDialog !== undefined ||
    profileDialog ||
    localTaskProject ||
    settingsProject ||
    invite
      ? undefined
      : projectView
        ? allTasks.find((item) => item.task.id === projectView.taskId)
        : selectedShared
          ? allTasks.find((item) => item.task.id === selectedShared)
          : allTasks.find(
              (item) => item.run?.task.runId === current?.task.runId,
            );
  const projects = [
    ...new Set([
      ...state.settings.projects.map((p) => p.id),
      ...runs.filter((r) => r.origin === "local").map((r) => r.task.projectId),
      ...shared.map((task) => task.projectId),
      ...(state.projectTasks ?? []).map((task) => task.projectId),
    ]),
  ];
  return (
    <div className={`agent-workspace ${sidebar ? "" : "sidebar-hidden"}`}>
      <TaskReadObserver
        scope={readScope}
        item={viewedTask}
        markRead={markRead}
      />
      <aside
        className="workspace-sidebar"
        aria-label="プロジェクトとタスク"
        onClickCapture={(event) => {
          if (
            !(event.target instanceof Element) ||
            !event.target.closest(
              ".task-link, .sidebar-nav button, [data-minutes-navigation]",
            )
          )
            return;
          if (!confirmNavigation()) {
            event.preventDefault();
            event.stopPropagation();
          } else {
            openingLink.current++;
            setLinkError("");
          }
        }}
      >
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
            className={`${currentPage === "overview" ? "nav-active" : ""} ${!state.connected ? "connection-required" : ""}`}
            onClick={() => {
              setProjectView(undefined);
              setPage("overview");
            }}
          >
            <Icon name="settings" />
            接続とセットアップ
            {!state.connected && (
              <span className="connection-prompt">未接続</span>
            )}
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
            <span>プロジェクト</span>
            <button
              className="icon-button"
              aria-label="プロジェクトを追加"
              disabled={!state.connected || !state.projectCreationSupported}
              onClick={() => setProjectDialog("")}
            >
              <Icon name="plus" size={18} />
            </button>
          </div>
          {projects.map((id) => {
            const project = state.settings.projects.find((p) => p.id === id);
            const projectConnected = state.connected && !!project;
            const items = filtered.filter((item) => item.task.projectId === id);
            if (query && !items.length) return null;
            return (
              <section
                key={id}
                data-project-id={id}
                className={`project-group ${!projectConnected ? "project-disconnected" : ""}`}
              >
                <Collapsible
                  storageKey={id}
                  className="project-collapse"
                  title={
                    <>
                      <Icon name="folder" size={16} />
                      <span>
                        {state.settings.projects.find((p) => p.id === id)
                          ?.name ?? "ローカルプロジェクト"}
                      </span>
                    </>
                  }
                  actions={
                    project && (
                      <div className="project-actions">
                        <ProjectMenu
                          project={project}
                          deviceId={state.settings.deviceId}
                          action={action}
                          startLocal={() => setLocalTaskProject(id)}
                          mapping={() => setSettingsProject(id)}
                        />
                        <button
                          className="icon-button project-compose"
                          data-minutes-navigation
                          aria-label={`${project.name}に新しいタスクを追加`}
                          title="新しいタスク"
                          disabled={!projectConnected}
                          onClick={() => {
                            setTaskDrafts((drafts) => ({
                              ...drafts,
                              [id]: drafts[id] ?? {
                                text: "",
                                requestId: crypto.randomUUID(),
                              },
                            }));
                            setProjectView({ projectId: id, draft: true });
                            selectShared(undefined);
                          }}
                        >
                          <Icon name="plus" size={18} />
                        </button>
                      </div>
                    )
                  }
                >
                  {project && (
                    <button
                      disabled={!projectConnected}
                      className={`task-link ${projectView?.projectId === id && !projectView.taskId && !projectView.draft ? "selected" : ""}`}
                      onClick={() => setProjectView({ projectId: id })}
                    >
                      <Icon name="file" size={15} />
                      <span>議事録</span>
                    </button>
                  )}
                  {Object.hasOwn(taskDrafts, id) && (
                    <button
                      disabled={!projectConnected}
                      className={`task-link ${projectView?.projectId === id && projectView.draft ? "selected" : ""}`}
                      onClick={() =>
                        setProjectView({ projectId: id, draft: true })
                      }
                    >
                      <span>新しいタスク</span>
                      <TaskAvatars
                        state={state}
                        task={{ id: `draft-${id}` }}
                        local
                      />
                    </button>
                  )}
                  <SidebarTaskList
                    projectId={id}
                    items={items}
                    state={state}
                    connected={projectConnected}
                    selected={viewedTask?.task.runId}
                    action={action}
                    seen={seen}
                    scope={readScope}
                    select={(item) => {
                      if (item.run) {
                        setProjectView(undefined);
                        select(item.task.runId);
                        selectShared(undefined);
                      } else if ("text" in item.task) {
                        setProjectView({ projectId: id, taskId: item.task.id });
                        selectShared(undefined);
                      } else {
                        setProjectView(undefined);
                        selectShared(item.task.id);
                      }
                      setPage("runs");
                    }}
                  />
                </Collapsible>
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
          {(!state.connected ||
            !state.teamTasksSupported ||
            !state.teamTasks ||
            sharedStale) && (
            <p className="sidebar-empty" role="status">
              {!state.connected
                ? "ほかのPCの状態を見るには接続してください。"
                : !state.teamTasksSupported
                  ? "チーム一覧にはEngineの更新が必要です。"
                  : !state.teamTasks
                    ? "チームのタスクを取得中…"
                    : sharedStale
                      ? "共有情報の更新が遅れています。"
                      : ""}
            </p>
          )}
          {state.teamTasks &&
            state.teamTasks.total > state.teamTasks.tasks.length && (
              <p className="sidebar-empty">
                チームの全{state.teamTasks.total}件中、進行中を優先して
                {state.teamTasks.tasks.length}件表示しています。
              </p>
            )}
        </div>
        <footer className="sidebar-footer">
          <button
            className="local-avatar"
            aria-label="ユーザー設定を開く"
            onClick={() => showProfile(true)}
          >
            <UserAvatar
              person={{
                id: "self",
                name: state.settings.profile?.name || "PC",
                avatar: state.settings.profile?.avatar,
              }}
            />
          </button>
          <div>
            <strong>
              {state.settings.profile?.name || "ユーザー名を設定"}
            </strong>
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
            data-minutes-navigation
            onClick={() => {
              setProjectView(undefined);
              setPage("overview");
            }}
          >
            <Icon name="settings" size={17} />
          </button>
        </footer>
      </aside>
      <Modal
        opened={!!settingsProject}
        onClose={() => setSettingsProject(undefined)}
        title={`${state.settings.projects.find((p) => p.id === settingsProject)?.name ?? "プロジェクト"} · 接続・設定`}
        size={640}
        centered
        className="project-settings-modal"
      >
        {settingsProject && (
          <ProjectSettings
            key={settingsProject}
            projectId={settingsProject}
            state={state}
            action={action}
          />
        )}
      </Modal>
      <InviteDialog
        invite={invite}
        connected={state.connected}
        onClose={() => {
          dismissInvite(invite?.token ?? "");
          setInvite(undefined);
          history.replaceState(null, "", location.pathname);
        }}
      />
      <Modal
        centered
        opened={profileDialog}
        onClose={() => showProfile(false)}
        title="ユーザー設定"
      >
        <ProfileSettings
          key={String(profileDialog)}
          state={state}
          action={action}
          saved={() => showProfile(false)}
        />
        <Text mt="lg">
          {state.loginStatus === "authenticated"
            ? "Codex連携済み"
            : "Codex未連携 — タスクは割り当てられません"}
        </Text>
        <Button
          mt="sm"
          variant="light"
          onClick={() => invoke("codex/doctor", {})}
        >
          Codex連携を確認
        </Button>
        <Button
          mt="sm"
          ml="sm"
          variant="light"
          onClick={() => invoke("codex/login", {})}
        >
          Codexにログイン
        </Button>
        {state.loginUrl && (
          <Anchor
            display="block"
            mt="sm"
            href={state.loginUrl}
            target="_blank"
            rel="noreferrer"
          >
            ログイン画面を開く
          </Anchor>
        )}
      </Modal>
      <Modal
        centered
        size={640}
        className="project-settings-modal"
        opened={projectDialog !== undefined}
        onClose={() => setProjectDialog(undefined)}
        title={
          projectDialog ? "プロジェクトの保存先を選択" : "プロジェクトを追加"
        }
      >
        <AddProjectForm
          key={projectDialog}
          projectId={projectDialog || undefined}
          action={action}
          saved={() => setProjectDialog(undefined)}
        />
      </Modal>
      <Modal
        opened={!!localTaskProject}
        onClose={() => setLocalTaskProject(undefined)}
        title="このPCでタスクを開始"
        size="lg"
      >
        {localTaskProject && (
          <NewLocalTask
            action={action}
            mode={
              state.settings.mappings.find(
                (m) => m.projectId === localTaskProject,
              )?.progressMode ?? "auto"
            }
            projects={state.settings.projects}
            initialProjectId={localTaskProject}
            initialDirectory={
              state.settings.mappings.find(
                (m) => m.projectId === localTaskProject,
              )?.directory
            }
            started={(runId) => {
              setLocalTaskProject(undefined);
              setProjectView(undefined);
              selectShared(undefined);
              select(runId);
              setPage("runs");
              void refresh();
            }}
          />
        )}
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
            {projectView && workspaceConnected
              ? (state.settings.projects.find(
                  (p) => p.id === projectView.projectId,
                )?.name ?? "プロジェクト")
              : currentPage === "overview"
                ? "接続とセットアップ"
                : (sharedCurrent?.title ??
                  (selectedShared
                    ? "共有タスク"
                    : (current?.task.title ?? current?.task.text)) ??
                  "タスク")}
          </h1>
          {state.lifecycleSupported &&
            (projectView?.taskId || sharedCurrent || current) &&
            (() => {
              const task = state.projectTasks?.find(
                (t) =>
                  t.id ===
                  (projectView?.taskId ??
                    sharedCurrent?.id ??
                    current?.task.id),
              );
              return task ? (
                <TaskMenu
                  task={task}
                  actorId={state.settings.deviceId}
                  action={action}
                  disabled={!workspaceConnected}
                />
              ) : null;
            })()}
          <button
            className="icon-button"
            aria-label="最新の状態に更新"
            onClick={() => void refresh()}
          >
            <Icon name="refresh" size={17} />
          </button>
        </header>
        {!!state.deletionSync?.pendingTasks && (
          <div role="status" className="workspace-error">
            削除したタスクのローカル履歴を整理中です。同期完了までお待ちください。
          </div>
        )}
        {linkError && (
          <div className="workspace-error" role="alert">
            {linkError}
          </div>
        )}
        {error && (
          <div className="workspace-error" role="alert">
            {error}
          </div>
        )}
        {workspaceConnected && projectView?.draft ? (
          <ProjectTaskDraft
            key={projectView.projectId}
            projectId={projectView.projectId}
            draft={taskDrafts[projectView.projectId]}
            sendingText={(sentText) =>
              setTaskDrafts((drafts) => ({
                ...drafts,
                [projectView.projectId]: {
                  ...drafts[projectView.projectId],
                  sentText,
                },
              }))
            }
            connected={state.connected}
            onChange={(text) =>
              setTaskDrafts((drafts) => ({
                ...drafts,
                [projectView.projectId]: {
                  ...drafts[projectView.projectId],
                  text,
                },
              }))
            }
            created={async (task) => {
              setProjectView({ projectId: task.projectId, taskId: task.id });
              setTaskDrafts((drafts) => {
                const copy = { ...drafts };
                delete copy[task.projectId];
                return copy;
              });
              await refresh();
            }}
          />
        ) : projectView && !projectView.draft ? (
          <ProjectView
            key={projectView.projectId}
            projectId={projectView.projectId}
            taskId={projectView.taskId}
            deviceId={state.settings.deviceId}
            clientState={state}
            openSettings={() => setSettingsProject(projectView.projectId)}
            openTask={(reference) => void openMinutesTask(reference)}
            dirtyChanged={dirtyChanged}
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
                  {state.connected
                    ? "アカウントと作業フォルダーを確認したら、タスクの準備は完了です。"
                    : "現在Engineに未接続です。接続すると、タスク・議事録の確認やメッセージの送信ができます。"}
                </p>
              </div>
              <ClientView
                page="overview"
                state={{
                  ...state,
                  suggestedEngine: invite?.engineUrl ?? state.suggestedEngine,
                }}
                action={action}
                invoke={invoke}
              />
            </div>
          </div>
        ) : selectedShared ? (
          sharedCurrent ? (
            <TeamTaskDetail
              state={state}
              openSettings={() => setSettingsProject(sharedCurrent!.projectId)}
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
            setup={() =>
              current &&
              state.settings.projects.some(
                (p) => p.id === current.task.projectId,
              )
                ? setSettingsProject(current.task.projectId)
                : setPage("overview")
            }
          />
        )}
      </main>
    </div>
  );
}
