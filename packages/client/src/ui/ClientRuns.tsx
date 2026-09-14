import { Modal } from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import type { Action, ClientState, Invoke } from "@ido/common-ui";
import type { ClientActivityState } from "@ido/common/contracts/api";
import { api } from "./api.js";
import {
  ActivityItem,
  activeState,
  MessageText,
  stateLabel,
} from "./ActivityFeed.js";
import { Icon } from "./Icons.js";

const controlError = (code: string) =>
  ({
    ENGINE_CONTROL_UNAVAILABLE:
      "Engineに接続してください。アプリからの追加指示に対応したEngineが必要です。",
    EXECUTION_NOT_ALLOWED: "接続設定でタスクの実行を許可してください。",
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
}: {
  state: ClientState;
  current?: ClientState["runs"][number];
  action: Action;
  invoke: Invoke;
  setup: () => void;
}) {
  const [activity, setActivity] = useState<ClientActivityState>();
  const [loadError, setLoadError] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [review, showReview] = useState(false);
  const [patch, setPatch] = useState("");
  const [details, showDetails] = useState(false);
  const [port, setPort] = useState("");
  const [follow, setFollow] = useState(true);
  const request = useRef<{ text: string; id: string }>(undefined);
  const scroll = useRef<HTMLDivElement>(null);
  const runId = current?.task.runId;
  useEffect(() => {
    if (!runId) return;
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
  }, [runId, current?.activityVersion, state]);
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
  const waitingPlan = running && current.phase === "awaiting-plan";
  const entries = activity?.entries ?? [];
  const files = [
    ...new Set(
      entries.flatMap((entry) => entry.files?.map((file) => file.path) ?? []),
    ),
  ];
  const approvals = state.approvals.filter(
    (approval) => !approval.runId || approval.runId === runId,
  );
  const policy =
    current.task.effectiveExecutionPolicy ?? current.task.executionPolicy;
  const canSend =
    running && state.connected && state.controlSupported && state.allow;
  async function submit() {
    const instruction = draft.trim();
    if (!instruction || sending || !canSend) return;
    if (request.current?.text !== instruction)
      request.current = { text: instruction, id: crypto.randomUUID() };
    setSending(true);
    setNotice("");
    try {
      await action("instruction", {
        runId,
        requestKey: request.current.id,
        instruction,
      });
      setDraft("");
      request.current = undefined;
      setNotice(
        "Engineが追加指示を受け付けました。反映状況は会話ログに表示されます。",
      );
      setFollow(true);
    } catch (error) {
      setNotice(controlError((error as Error).message));
    } finally {
      setSending(false);
    }
  }
  async function openDiff() {
    showReview(true);
    setPatch("変更を読み込んでいます…");
    try {
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
    <section className="task-workspace" aria-label="タスクの会話と行動ログ">
      <div className="task-topline">
        <span className={`task-state ${running ? "working" : ""}`}>
          <span
            className={`task-dot ${running && !waitingPlan ? "active" : current.state}`}
          />
          {waitingPlan
            ? "計画の確認待ち"
            : current.phase === "planning" && running
              ? "相談・計画中"
              : stateLabel(current.state)}
        </span>
        <span>実行 {current.task.revision}</span>
        <button className="text-button" onClick={() => showDetails(!details)}>
          <Icon name="folder" size={15} />
          作業フォルダー
        </button>
        <button className="text-button" onClick={() => void openDiff()}>
          <Icon name="file" size={15} />
          変更を確認
        </button>
      </div>
      {details && (
        <div className="workspace-detail">
          <label>WORKSPACE</label>
          <code>{current.directory}</code>
          <form
            onSubmit={(e) => {
              e.preventDefault();
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
              onChange={(e) => setPort(e.currentTarget.value)}
              required
            />
            <button className="soft-button" type="submit">
              プレビューを登録
            </button>
          </form>
        </div>
      )}
      <div
        className="conversation-scroll"
        ref={scroll}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 100);
        }}
      >
        <div className="conversation-content">
          <article className="user-message initial-request">
            <div className="entry-meta">Discordからの依頼</div>
            <MessageText text={current.task.text} />
          </article>
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
              {running
                ? "エージェントの作業開始を待っています。"
                : "このタスクには詳細な行動ログがありません。新しい実行から記録されます。"}
            </div>
          )}
          {entries.map((entry) => (
            <ActivityItem key={entry.id} entry={entry} />
          ))}
          {current.result &&
            !entries.some(
              (entry) =>
                entry.kind === "message" &&
                entry.title === "結果" &&
                entry.revision === current.task.revision,
            ) && (
              <article className="agent-message">
                <div className="entry-meta">IDO Agent · 結果</div>
                <MessageText text={current.result} />
              </article>
            )}
          {files.length > 0 && (
            <div className="changes-card">
              <div>
                <Icon name="file" />
                <strong>{files.length} 件のファイルを変更</strong>
                <button className="soft-button" onClick={() => void openDiff()}>
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
                  <summary>あと {files.length - 4} 件のファイルを表示</summary>
                  {files.slice(4).map((path) => (
                    <div className="changed-file" key={path}>
                      <code>{path}</code>
                    </div>
                  ))}
                </details>
              )}
            </div>
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
          </div>
        ))}
        {notice && (
          <div className="composer-notice" role="status">
            {notice}
          </div>
        )}
        {waitingPlan && (
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
              canSend
                ? "追加の指示や確認したいことをどうぞ"
                : running
                  ? "接続と実行許可を確認してください"
                  : "このタスクは終了しています"
            }
            value={draft}
            maxLength={8000}
            disabled={!canSend || sending}
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
            <span
              className="progress-mode"
              title="タスクの進め方。実行権限とは別です。"
            >
              {current.progressMode === "manual" ? "Manual · 会話する" : "Auto"}
            </span>
            <button type="button" className="policy-button" onClick={setup}>
              <Icon name="shield" size={16} />
              {policy?.sandboxMode === "read-only"
                ? "読み取り専用"
                : "作業フォルダー内で実行"}
            </button>
            <span className="composer-spacer" />
            <span className="model-label">Codex</span>
            <button
              type="submit"
              className="send-button"
              aria-label="追加指示を送信"
              disabled={!canSend || sending || !draft.trim()}
            >
              <Icon name="arrow" size={18} />
            </button>
            <button
              type="button"
              className="stop-button"
              aria-label="タスクを停止"
              title="タスクを停止"
              disabled={!running}
              onClick={() => invoke("stop", { runId })}
            >
              <Icon name="stop" size={14} />
            </button>
          </div>
        </form>
        <p className="composer-footnote">
          {canSend
            ? "Enterで送信 · Shift + Enterで改行"
            : "新しい依頼と再実行はDiscord・Dashboardから"}
          <span>行動ログはこのPCに保存</span>
        </p>
      </div>
      <Modal
        opened={review}
        onClose={() => showReview(false)}
        title="作業フォルダーの変更"
        size="xl"
      >
        <p className="muted">
          現在の未コミット差分です。保存済みの行動ログとは異なる場合があります。
        </p>
        <pre className="diff-preview">{patch}</pre>
      </Modal>
    </section>
  );
}
