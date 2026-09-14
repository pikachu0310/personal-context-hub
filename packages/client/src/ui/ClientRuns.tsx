import { TaskFollowup } from "./TaskFollowup.js";
import { TaskConversation } from "./TaskConversation.js";
import { accessOptions } from "./access-mode.js";
import type { TaskDetailRead } from "@ido/common/contracts/api";
import { TaskOwner } from "./TaskOwner.js";
import {
  initialSender,
  displaySender,
  showStart,
} from "./chat-presentation.js";
import { ComposerDropdown } from "./ComposerDropdown.js";
import { ModelControls } from "./ModelControls.js";
import { ComposerAction } from "./ComposerAction.js";
import { Button, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { EnvironmentRow, TaskInspector } from "./TaskInspector.js";
import { useEffect, useRef, useState } from "react";
import type { Action, ClientState, Invoke } from "@ido/common-ui";
import type {
  TaskEnvironment,
  ClientActivityState,
} from "@ido/common/contracts/api";
import { api } from "./api.js";
import {
  ActivityItem,
  activeState,
  RequestMessage,
  MessageText,
  stateLabel,
} from "./ActivityFeed.js";
import { Icon } from "./Icons.js";

const controlError = (code: string) =>
  ({
    ENGINE_CONTROL_UNAVAILABLE:
      "Engineに接続してください。アプリからの追加指示に対応したEngineが必要です。",
    EXECUTION_NOT_ALLOWED: "プロジェクトの接続・設定で実行を許可してください。",
    CONTINUATION_UNSUPPORTED:
      "Engineを更新すると、このタスクの続きを依頼できます。",
    TASK_STILL_ACTIVE:
      "タスクがすでに再開されています。最新の状態を確認してください。",
    LOCAL_SLOTS_FULL:
      "実行枠が埋まっています。実行中のタスクが終わってから送信してください。",
    INSTRUCTION_DELIVERY_UNCERTAIN:
      "前の指示の実行結果が未確認です。先にその指示を確認してください。",
    TASK_NOT_RUNNING:
      "このタスクは実行中ではありません。再実行はチームのDashboardから操作してください。",
    CONTROL_DELIVERY_UNKNOWN:
      "配送結果を確認できません。会話ログを確認してください。再送時は同じ受付IDを使用します。",
    PERMISSION_DENIED: "この操作を行う権限がありません。",
    TASK_NOT_OWNED_BY_DEVICE:
      "タスクの担当または実行版が変わりました。最新の状態を確認してください。",
  })[code] ??
  "操作を完了できませんでした。接続状態とタスクの状態を確認してください。";

export function ClientRuns({
  state,
  current,
  action,
  invoke,
  setup,
  remote,
}: {
  state: ClientState;
  current?: ClientState["runs"][number];
  action: Action;
  invoke: Invoke;
  setup: () => void;
  remote?: {
    detail: TaskDetailRead;
    notice: string;
    refresh: () => Promise<void>;
  };
}) {
  const [localActivity, setActivity] = useState<ClientActivityState>();
  const activity = remote
    ? (remote.detail.snapshot?.activity ?? {
        entries: [],
        dropped: 0,
        version: 0,
      })
    : localActivity;
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [savingModel, setSavingModel] = useState(false);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState<string | null>("environment");
  const [reveal, setReveal] = useState(0);
  const [sourceId, setSourceId] = useState<string>();
  const [environmentVersion, setEnvironmentVersion] = useState(0);
  const [localEnvironment, setEnvironment] = useState<TaskEnvironment>();
  const environment = remote
    ? remote.detail.snapshot?.environment
    : localEnvironment;
  const [environmentError, setEnvironmentError] = useState("");
  const [patch, setPatch] = useState("");
  const [port, setPort] = useState("");
  const [follow, setFollow] = useState(true);
  const request = useRef<{
    text: string;
    id: string;
    continuation: boolean;
    revision: number;
  }>(undefined);
  const scroll = useRef<HTMLElement>(null);
  const runId = current?.task.runId;
  useEffect(() => {
    if (!runId || remote) return;
    let disposed = false;
    void api<TaskEnvironment>(
      `task-environment?runId=${encodeURIComponent(runId)}`,
    )
      .then((data) => {
        if (!disposed) {
          setEnvironment(data);
          setEnvironmentError("");
        }
      })
      .catch(() => {
        if (!disposed) {
          setEnvironment(undefined);
          setEnvironmentError("実行環境を取得できませんでした。");
        }
      });
    return () => {
      disposed = true;
    };
  }, [
    runId,
    current?.state,
    current?.task.revision,
    environmentVersion,
    remote,
  ]);
  useEffect(() => {
    if (!runId || remote) return;
    let disposed = false;
    void api<ClientActivityState>(`activity?runId=${encodeURIComponent(runId)}`)
      .then((data) => {
        if (!disposed) {
          setActivity(data);
          setLoadError("");
        }
      })
      .catch(() => {
        if (!disposed)
          setLoadError(
            "行動ログを読み込めませんでした。接続状態を確認し、更新してください。",
          );
      });
    return () => {
      disposed = true;
    };
  }, [runId, current?.activityVersion, state, remote]);
  useEffect(() => {
    if (follow && scroll.current)
      scroll.current.scrollTop = scroll.current.scrollHeight;
  }, [activity?.version, current?.result, follow]);
  if (!current)
    return (
      <div className="empty-workspace">
        <div className="empty-mark">
          <Icon name="terminal" size={30} />
        </div>
        <h2>一緒に、次の作業へ。</h2>
        <p>
          Discordから依頼すると、このPCのタスクがここに届きます。
          <br />
          会話とコマンドの実行内容を、一つの画面で確認できます。
        </p>
        <button className="soft-button" onClick={setup}>
          <Icon name="settings" />
          接続とセットアップ
        </button>
      </div>
    );
  const running = activeState(current.state);
  const local = current.origin === "local" && !remote;
  const agentName = current.agent === "claude" ? "Claude Code" : "Codex";
  const waitingPlan = running && current.phase === "awaiting-plan";
  const entries = activity?.entries ?? [];
  const files = [
    ...new Set(
      entries.flatMap((entry) => entry.files?.map((file) => file.path) ?? []),
    ),
  ];
  const approvals = (
    remote ? (remote.detail.snapshot?.approvals ?? []) : state.approvals
  ).filter((approval) => !approval.runId || approval.runId === runId);
  const policy =
    current.task.effectiveExecutionPolicy ?? current.task.executionPolicy;
  const accessLabel =
    !policy?.sandboxMode &&
    policy?.networkAccessEnabled !== false &&
    current.accessMode === "full"
      ? "フルアクセス・承認なし"
      : !policy?.sandboxMode &&
          policy?.networkAccessEnabled !== false &&
          current.accessMode === "approval"
        ? "許可を求める"
        : current.agent === "claude"
          ? "Claude · 操作ごとに承認"
          : policy?.sandboxMode === "read-only"
            ? "読み取り専用"
            : "作業フォルダー内で実行";
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(
    current.state,
  );
  const canSend =
    !remote &&
    (running || terminal) &&
    (local ||
      (state.connected &&
        (terminal
          ? state.continuationSupported === true
          : state.controlSupported &&
            (state.allowedProjectIds?.includes(current.task.projectId) ??
              state.allow))));
  async function submit() {
    const instruction = draft.trim();
    if (!instruction || sending || savingModel || !canSend) return;
    if (request.current?.text !== instruction)
      request.current = {
        text: instruction,
        id: crypto.randomUUID(),
        continuation: terminal,
        revision: current!.task.revision,
      };
    setSending(true);
    setNotice("");
    try {
      await action(request.current.continuation ? "continue" : "instruction", {
        runId,
        requestKey: request.current.id,
        revision: request.current.revision,
        instruction,
      });
      setDraft("");
      request.current = undefined;
      setNotice(
        local
          ? "このPCで追加指示を受け付けました。反映状況は会話ログに表示されます。"
          : "Engineが追加指示を受け付けました。反映状況は会話ログに表示されます。",
      );
      setFollow(true);
    } catch (error) {
      setNotice(controlError((error as Error).message));
    } finally {
      setSending(false);
    }
  }
  async function openDiff() {
    setReveal((value) => value + 1);
    setTab("changes");
    setPatch("変更を読み込んでいます…");
    try {
      if (remote) {
        await remote.refresh();
        return;
      }
      const result = await action("diff", { runId });
      setPatch(
        result.patch || "現在の作業フォルダーに未コミットの差分はありません。",
      );
    } catch {
      setPatch(
        "差分を取得できませんでした。作業フォルダーが存在するか確認してください。",
      );
    }
  }
  return (
    <section
      className="task-workspace with-inspector"
      aria-label="タスクの会話と行動ログ"
      ref={scroll}
      onScroll={(e) => {
        const el = e.currentTarget;
        setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
      }}
    >
      <div className="task-conversation">
        <div className="conversation-scroll">
          <div className="conversation-content">
            {remote && (
              <>
                <h2>{current.task.title ?? current.task.text}</h2>
                <p role="status">{remote.notice}</p>
              </>
            )}
            <RequestMessage
              sender={displaySender(
                initialSender(current.task, local, state),
                state,
              )}
              sentAt={current.task.createdAt}
              text={
                current.task.initialText ??
                current.task.history[0]?.text ??
                current.task.text
              }
            >
              {!!current.contextSources?.length && (
                <div className="source-chips">
                  {[
                    ...new Set(
                      current.contextSources.map((source) =>
                        source.kind === "minutes"
                          ? "議事録"
                          : source.kind === "profile"
                            ? "ユーザー情報"
                            : "共有コンテキスト",
                      ),
                    ),
                  ].map((label) => (
                    <button
                      className="source-chip"
                      key={label}
                      onClick={() => {
                        setTab("sources");
                        setSourceId(
                          current.contextSources?.find((source) =>
                            label === "議事録"
                              ? source.kind === "minutes"
                              : label === "ユーザー情報"
                                ? source.kind === "profile"
                                : source.kind === "context",
                          )?.id,
                        );
                        setReveal((value) => value + 1);
                      }}
                    >
                      @{label}
                    </button>
                  ))}
                </div>
              )}
            </RequestMessage>
            {current.task.history
              .filter(
                (history) =>
                  !entries.some((entry) => entry.revision === history.revision),
              )
              .map((history) => (
                <article key={`history-${history.revision}`}>
                  <div className="timeline-status">実行 {history.revision}</div>
                  {history.text !==
                    (current.task.initialText ??
                      current.task.history[0]?.text ??
                      current.task.text) && (
                    <RequestMessage text={history.text} />
                  )}
                  {history.result && <MessageText text={history.result} />}
                </article>
              ))}
            {current.task.revision > 1 &&
              !entries.some(
                (entry) =>
                  entry.revision === current.task.revision &&
                  entry.kind === "instruction",
              ) &&
              current.task.text !==
                (current.task.initialText ?? current.task.history[0]?.text) && (
                <RequestMessage text={current.task.text} />
              )}
            {current.task.queuedInstructions?.map((message) => (
              <RequestMessage
                key={message.id}
                text={message.text}
                sender={displaySender(message.sender, state)}
                sentAt={message.sentAt}
              />
            ))}
            {loadError && (
              <p role="alert" className="is-error">
                {loadError}
              </p>
            )}
            {(activity?.dropped ?? 0) > 0 && (
              <div className="timeline-status">
                古い行動ログ {activity?.dropped} 件を省略しています。
              </div>
            )}
            {!activity && !loadError && (
              <div className="timeline-status">行動ログを読み込んでいます…</div>
            )}
            {activity && !entries.length && (
              <div className="timeline-status">
                {remote && !remote.detail.snapshot
                  ? "実行PCに残る詳細履歴は、対応版Clientの接続後に同期されます。"
                  : running
                    ? "エージェントの作業開始を待っています。"
                    : "このタスクには保存された詳細な行動ログがありません。"}
              </div>
            )}
            {entries
              .filter((entry) =>
                showStart(entry, current.task.createdAt, entries),
              )
              .map((entry) => (
                <ActivityItem
                  key={entry.id}
                  entry={entry}
                  sender={displaySender(entry.sender, state)}
                />
              ))}
            {remote?.detail.snapshot?.plan &&
              !entries.some(
                (entry) =>
                  entry.kind === "message" &&
                  entry.text === remote.detail.snapshot?.plan,
              ) && (
                <article className="agent-message">
                  <MessageText text={remote.detail.snapshot.plan} />
                </article>
              )}
            {current.result &&
              !entries.some(
                (entry) =>
                  entry.kind === "message" &&
                  entry.title === "結果" &&
                  entry.revision === current.task.revision,
              ) && (
                <article className="agent-message">
                  <MessageText text={current.result} />
                </article>
              )}
            {files.length > 0 && (
              <div className="changes-card">
                <div>
                  <Icon name="file" />
                  <strong>{files.length} 件のファイルを変更</strong>
                  <button
                    className="soft-button"
                    onClick={() => void openDiff()}
                  >
                    変更を確認
                  </button>
                </div>
                {files.slice(0, 4).map((path) => (
                  <div className="changed-file" key={path}>
                    <code>{path}</code>
                    <span>変更</span>
                  </div>
                ))}
                {files.length > 4 && (
                  <details>
                    <summary>
                      あと {files.length - 4} 件のファイルを表示
                    </summary>
                    {files.slice(4).map((path) => (
                      <div className="changed-file" key={path}>
                        <code>{path}</code>
                      </div>
                    ))}
                  </details>
                )}
              </div>
            )}
            {(!local || current.discordShare?.taskId) && (
              <details className="shared-conversation-panel">
                <summary>チームとの共有会話</summary>
                <TaskConversation
                  projectId={current.task.projectId}
                  taskId={
                    local ? current.discordShare?.taskId : current.task.id
                  }
                  connected={
                    state.connected &&
                    state.settings.projects.some(
                      (p) => p.id === current.task.projectId,
                    )
                  }
                />
              </details>
            )}
            {running && !waitingPlan && (
              <div className="working-indicator" role="status">
                <span className="task-dot active" />
                {current.phase === "planning" ? "計画を考えています" : "作業中"}
                <span>実行内容は随時ここに表示されます</span>
              </div>
            )}
          </div>
        </div>
        <div className="composer-dock">
          {!follow && (
            <button
              className="jump-latest soft-button"
              onClick={() => setFollow(true)}
            >
              最新のログへ ↓
            </button>
          )}
          {approvals.map((approval) => (
            <div className="approval-card" key={approval.id}>
              <div>
                <Icon name="shield" />
                <strong>この操作の承認が必要です</strong>
              </div>
              <details>
                <summary>{approval.method}</summary>
                <pre>{JSON.stringify(approval.params, null, 2)}</pre>
              </details>
              {!remote && (
                <div className="approval-actions">
                  <button
                    className="soft-button"
                    onClick={() =>
                      invoke("approval", { id: approval.id, allow: false })
                    }
                  >
                    拒否
                  </button>
                  <button
                    className="primary-button"
                    onClick={() =>
                      invoke("approval", { id: approval.id, allow: true })
                    }
                  >
                    この操作を許可
                  </button>
                </div>
              )}
              {remote && <p>承認は実行PCで行ってください。</p>}
            </div>
          ))}
          {notice && (
            <div className="composer-notice" role="status">
              {notice}
            </div>
          )}
          {waitingPlan && !remote && (
            <div className="plan-card">
              <div>
                <strong>この計画で進めますか？</strong>
                <p>相談を続ける場合は、下の入力欄から送信してください。</p>
              </div>
              <button
                className="primary-button"
                disabled={!canSend || sending}
                onClick={() => invoke("execute-plan", { runId })}
              >
                <Icon name="arrow" size={15} />
                実行する
              </button>
            </div>
          )}
          {!remote && (
            <>
              <form
                className="composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <textarea
                  aria-label="エージェントへの追加指示"
                  placeholder={
                    terminal
                      ? "このタスクの続きを依頼する"
                      : "追加の指示や確認したいことをどうぞ"
                  }
                  value={draft}
                  maxLength={8000}
                  disabled={sending}
                  onChange={(e) => setDraft(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                />
                <div className="composer-toolbar">
                  <ComposerDropdown
                    label="入力欄の進め方"
                    value={
                      current.pendingProgressMode ??
                      current.progressMode ??
                      "auto"
                    }
                    options={[
                      { value: "auto", label: "Auto" },
                      { value: "manual", label: "Manual" },
                    ]}
                    onChange={(mode) =>
                      invoke("progress-mode", { runId, mode })
                    }
                  />
                  <ComposerDropdown
                    label="実行権限"
                    value={current.accessMode ?? "sandbox"}
                    disabled={running || sending}
                    options={accessOptions.filter(
                      (option) =>
                        current.agent !== "claude" ||
                        option.value !== "sandbox",
                    )}
                    onChange={(value) => {
                      invoke("access-mode", { runId, accessMode: value });
                    }}
                  />
                  <span className="composer-spacer" />
                  <ModelControls
                    key={runId}
                    runId={runId}
                    agent={current.agent ?? "codex"}
                    onBusyChange={setSavingModel}
                  />
                  <ComposerAction
                    running={running}
                    text={draft}
                    busy={sending || savingModel}
                    canSend={!!canSend}
                    sendLabel="追加指示を送信"
                    stop={() => invoke("stop", { runId })}
                  />
                </div>
              </form>
              <p className="composer-footnote">
                {running && (
                  <span>
                    権限を変える場合はタスクを停止し、変更後に追加指示を送って再開できます。
                  </span>
                )}
                {canSend
                  ? "Enterで送信 · Shift + Enterで改行"
                  : "送信するには接続とプロジェクトの実行設定を確認してください"}
                <span>
                  {current.agent === "claude"
                    ? "追加指示は現在の処理後に同じセッションで続行"
                    : "共有タスクの行動ログはEngineにも同期"}
                </span>
              </p>
            </>
          )}
          {remote && (
            <>
              <p className="composer-footnote">
                <span>
                  進め方:{" "}
                  {current.pendingProgressMode ??
                    current.progressMode ??
                    "auto"}
                </span>
                <span>{accessLabel}</span>
                <span>
                  {current.model ?? "既定モデル"}
                  {current.reasoningEffort
                    ? ` · ${current.reasoningEffort}`
                    : ""}
                </span>
              </p>
              <TaskFollowup task={remote.detail.task} state={state} />
            </>
          )}
        </div>
      </div>
      <TaskInspector
        sourceTarget={{
          taskId: current.task.id,
          projectId: current.task.projectId,
          runId: remote ? undefined : current.task.runId,
        }}
        sourceId={sourceId}
        onSourceChange={setSourceId}
        reveal={reveal}
        tab={tab}
        onTabChange={(next) => {
          if (next === "changes") void openDiff();
          else setTab(next);
        }}
        sources={[
          ...new Map(
            [
              ...(current.contextSources ?? []),
              ...(current.task.attachedSources ?? []),
            ].map((source) => [source.id, source]),
          ).values(),
        ]}
        sourceNote={
          current.contextSources === undefined
            ? "この実行には、渡されたコンテキストの記録がありません。"
            : "実行時にエージェントへ渡した内容です。"
        }
        changes={
          <Stack gap="sm">
            <Group justify="space-between">
              <Text fw={600} size="sm">
                作業フォルダーの変更
              </Text>
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() => void openDiff()}
              >
                再読み込み
              </Button>
            </Group>
            <Text size="xs" c="dimmed">
              現在の未コミット差分です。保存済みの行動ログとは異なる場合があります。
            </Text>
            {remote?.detail.snapshot?.patchAt && (
              <Text size="xs" c="dimmed">
                差分の取得日時:{" "}
                {new Date(remote.detail.snapshot.patchAt).toLocaleString()}
              </Text>
            )}
            {remote?.detail.snapshot?.patchError && (
              <p role="alert">{remote.detail.snapshot.patchError}</p>
            )}
            <pre className="diff-preview" role="status">
              {remote
                ? remote.detail.snapshot?.patch ||
                  (remote.detail.snapshot?.patchAt
                    ? "現在の作業フォルダーに未コミットの差分はありません。"
                    : "差分はまだ同期されていません。")
                : patch || "変更を読み込んでいます…"}
            </pre>
          </Stack>
        }
      >
        <Stack gap="sm">
          <Group justify="space-between">
            <Text size="sm" c="dimmed">
              作業環境
            </Text>
            <Button
              variant="subtle"
              size="compact-xs"
              aria-label="環境を更新"
              onClick={() =>
                remote
                  ? void remote.refresh()
                  : setEnvironmentVersion((value) => value + 1)
              }
            >
              <Icon name="refresh" size={14} />
            </Button>
          </Group>
          <UnstyledButton
            className="inspector-action"
            onClick={() => void openDiff()}
          >
            <Icon name="changes" size={17} />
            <span>
              変更を確認{files.length ? ` · ${files.length} ファイル` : ""}
            </span>
          </UnstyledButton>
          <EnvironmentRow label="実行PC">
            <Icon name="computer" size={17} />
            {environment?.deviceName ?? (remote ? "未同期" : "このPC")}
          </EnvironmentRow>
          <EnvironmentRow label="作業ブランチ">
            <Icon name="branch" size={17} />
            <code>
              {environment?.branch ??
                (environment?.commit
                  ? `detached HEAD · ${environment.commit.slice(0, 8)}`
                  : "取得できません")}
            </code>
          </EnvironmentRow>
          <EnvironmentRow label="作業フォルダー">
            <Icon name="folder" size={17} />
            <code>{current.directory || "未同期"}</code>
          </EnvironmentRow>
          {(environmentError || remote?.detail.snapshot?.environmentError) && (
            <Text size="xs" c="red" role="alert">
              {environmentError || remote?.detail.snapshot?.environmentError}
            </Text>
          )}
          {!local && !remote && (
            <details className="preview-options">
              <summary>プレビュー</summary>
              <form
                className="preview-port-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  invoke("preview", { runId, port: Number(port) });
                }}
              >
                <input
                  aria-label="プレビュー用ローカルポート"
                  type="number"
                  min={1024}
                  max={65535}
                  placeholder="プレビューポート"
                  value={port}
                  onChange={(event) => setPort(event.currentTarget.value)}
                  required
                />
                <Button type="submit" variant="default" size="compact-xs">
                  プレビューを登録
                </Button>
              </form>
            </details>
          )}
        </Stack>
        <Stack className="inspector-section" gap="sm">
          <Text size="sm" c="dimmed">
            タスク
          </Text>
          <EnvironmentRow label="担当者">
            <TaskOwner
              state={state}
              task={current.task}
              local={!remote}
              ownerName={environment?.ownerName}
            />
          </EnvironmentRow>
          <EnvironmentRow label="開始">
            {current.task.createdByBot
              ? "IDO Bot"
              : local
                ? "このアプリ"
                : current.task.participants?.find(
                    (person) => person.id === current.task.authorId,
                  )?.name || "プロジェクトからの依頼"}
          </EnvironmentRow>
          <EnvironmentRow label="状態">
            <span
              className={`task-dot ${running && !waitingPlan ? "active" : current.state}`}
            />
            <span>
              {waitingPlan
                ? "計画の確認待ち"
                : current.phase === "planning" && running
                  ? "相談・計画中"
                  : stateLabel(current.state)}
            </span>
          </EnvironmentRow>
          <EnvironmentRow label="エージェント">
            {agentName} · {current.model ?? "既定モデル"}
          </EnvironmentRow>
          <EnvironmentRow label="実行">
            {current.task.revision}
            {local ? " · ローカルで開始" : ""}
          </EnvironmentRow>
          {local && (
            <EnvironmentRow label="共有">
              {current.discordShare ? "Discord共有" : "PC内のみ"}
            </EnvironmentRow>
          )}
          {current.discordShare && (
            <p role="status" className="composer-notice">
              {current.discordShare.status === "synced"
                ? "Discord共有用タスクをEngineに登録済みです。スレッド反映はBotの同期後に行われます。"
                : current.discordShare.error === "DISCORD_FORUM_REQUIRED"
                  ? "共有待ち：このプロジェクトのissueフォーラムをBot側で設定してください。"
                  : current.discordShare.error === "ENGINE_UPDATE_REQUIRED"
                    ? "共有待ち：Engineを対応版に更新してください。"
                    : "Discordへの共有待ちです。同じチームへの接続後に再試行します。"}
            </p>
          )}
        </Stack>
      </TaskInspector>
    </section>
  );
}
