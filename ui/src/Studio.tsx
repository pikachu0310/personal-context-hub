import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ArrowRight,
  Check,
  CheckCheck,
  ChevronDown,
  Circle,
  Clipboard,
  ExternalLink,
  GitCompareArrows,
  LoaderCircle,
  Maximize2,
  MessageCircle,
  Monitor,
  PanelRightClose,
  Plus,
  Radio,
  RefreshCw,
  Send,
  Settings2,
  ShieldCheck,
  Smartphone,
  Square,
  Unplug,
  X,
} from "lucide-react";
import {
  currentPreview,
  stateLabel,
  type Actor,
  type Room,
  type StudioSnapshot,
  type StudioTask,
} from "./studio-model";
import "./studio.css";

const tokenKey = "idd-studio-session";
const pendingKey = "idd-studio-pending";
const commandId = () =>
  typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(24)), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
const initialToken = () => {
  try {
    return sessionStorage.getItem(tokenKey) ?? "";
  } catch {
    return "";
  }
};
const formatTime = (at: number) =>
  Number.isFinite(at)
    ? new Date(at).toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "";
const stageName: Record<string, string> = {
  EXECUTE: "Codex",
  QUEUE: "受付",
  OBSERVE: "会話の整理",
  DELIVER: "回答",
  IMMEDIATE: "回答",
  STT: "音声認識",
  ASSEMBLE: "会話",
};
type Command = Record<string, unknown>;

export function Studio() {
  const [token, setToken] = useState(initialToken);
  const [actor, setActor] = useState<Actor>();
  const [code, setCode] = useState(
    () => new URLSearchParams(location.hash.slice(1)).get("code") ?? "",
  );
  const [name, setName] = useState("");
  const [title, setTitle] = useState("");
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [invites, setInvites] = useState<{
    viewer: string;
    operator?: string;
  }>();
  const connectionDialog = useRef<HTMLDialogElement>(null);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomId, setRoomId] = useState("");
  const [snapshot, setSnapshot] = useState<StudioSnapshot>();
  const [connected, setConnected] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [compareId, setCompareId] = useState("");
  const [stage, setStage] = useState(location.pathname === "/stage");
  const [mobilePreview, setMobilePreview] = useState(false);
  const [pane, setPane] = useState<"conversation" | "spec" | "activity">(
    "conversation",
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [variants, setVariants] = useState(false);
  const [request, setRequest] = useState("");
  const [criteria, setCriteria] = useState("");
  const [variantA, setVariantA] = useState("");
  const [variantB, setVariantB] = useState("");
  const [draft, setDraft] = useState("");
  const [draftTarget, setDraftTarget] = useState<Command>();
  const [composerMode, setComposerMode] = useState<"say" | "ask" | "follow">(
    "say",
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(() => {
    try {
      return sessionStorage.getItem(pendingKey)
        ? "結果を確認できていない送信があります。同じ送信を再試行できます。"
        : "";
    } catch {
      return "";
    }
  });
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<
    { command: Command; room: string } | undefined
  >(() => {
    try {
      return (
        JSON.parse(sessionStorage.getItem(pendingKey) ?? "null") ?? undefined
      );
    } catch {
      return undefined;
    }
  });
  const rememberPending = (
    value: { command: Command; room: string } | undefined,
  ) => {
    try {
      if (value) sessionStorage.setItem(pendingKey, JSON.stringify(value));
      else sessionStorage.removeItem(pendingKey);
    } catch {
      /* In-memory retry is still available. */
    }
    setPending(value);
  };
  const [refresh, setRefresh] = useState(0);
  const createDialog = useRef<HTMLDialogElement>(null);
  const previousRoom = useRef("");
  const task = snapshot?.tasks.find((item) => item.id === selectedId);
  const comparison = snapshot?.tasks.find((item) => item.id === compareId);
  const canOperate = actor?.role === "operator" && connected;
  const running =
    snapshot?.tasks.filter((item) => ["running", "queued"].includes(item.state))
      .length ?? 0;

  useEffect(() => {
    document.title = "井戸Bot · 共有スタジオ";
    if (location.hash)
      history.replaceState(null, "", location.pathname + location.search);
  }, []);
  useEffect(() => {
    if (createOpen) createDialog.current?.showModal();
    else createDialog.current?.close();
  }, [createOpen]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    if (!draft.trim()) setDraftTarget(undefined);
  }, [selectedId]);
  useEffect(() => {
    if (connectionOpen) connectionDialog.current?.showModal();
    else connectionDialog.current?.close();
  }, [connectionOpen]);
  async function showConnection() {
    try {
      setInvites(await api("/api/studio/invites"));
      setConnectionOpen(true);
    } catch (failure) {
      setError((failure as Error).message);
    }
  }
  async function copyLink(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("リンクをコピーしました。");
    } catch {
      setNotice("リンク欄を選択してコピーしてください。");
    }
  }
  async function api(
    path: string,
    options: RequestInit = {},
    accessToken = token,
  ) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        ...options.headers,
      },
    });
    const data = await response.json();
    if (!response.ok) {
      if (response.status === 401 && accessToken) {
        sessionStorage.removeItem(tokenKey);
        setToken("");
        setConnected(false);
      }
      throw Object.assign(new Error(data.error ?? "接続を確認してください。"), {
        status: response.status,
      });
    }
    return data;
  }
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    api("/api/studio/rooms")
      .then((data) => {
        if (cancelled) return;
        setRooms(data.rooms);
        setActor(data.actor);
        setRoomId((id) =>
          data.rooms.some((room: Room) => room.id === id)
            ? id
            : data.rooms.some((room: Room) => room.id === pending?.room)
              ? pending!.room
              : (data.rooms[0]?.id ?? ""),
        );
      })
      .catch((failure) => {
        if (!cancelled) setError(failure.message);
      });
    return () => {
      cancelled = true;
    };
  }, [token, refresh]);
  useEffect(() => {
    if (!token || !roomId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    if (previousRoom.current !== roomId) {
      setSnapshot(undefined);
      setSelectedId("");
      setCompareId("");
      if (pending?.room !== roomId) rememberPending(undefined);
      setDraft("");
      setComposerMode("say");
      previousRoom.current = roomId;
    }
    const poll = async () => {
      try {
        const data: StudioSnapshot = await api(
          `/api/studio/rooms/${roomId}/snapshot`,
          { signal: abort.signal },
        );
        if (cancelled) return;
        setSnapshot(data);
        setConnected(true);
        setActor(data.actor);
        setSelectedId((id) =>
          data.tasks.some((item) => item.id === id)
            ? id
            : (data.tasks.at(-1)?.id ?? ""),
        );
      } catch (failure) {
        if (!cancelled) {
          setConnected(false);
          setError(
            (failure as Error).message === "Failed to fetch"
              ? "エンジンとの接続が切れました。入力はこの画面に残っています。"
              : (failure as Error).message,
          );
        }
      }
      if (!cancelled) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      cancelled = true;
      abort.abort();
      clearTimeout(timer);
    };
  }, [token, roomId, refresh]);
  async function login(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api(
        "/api/studio/login",
        {
          method: "POST",
          body: JSON.stringify({ name: name.trim() || "参加者", code }),
        },
        "",
      );
      sessionStorage.setItem(tokenKey, data.token);
      setToken(data.token);
      setActor(data.actor);
      setCode("");
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function send(command: Command, retry = false) {
    if (!snapshot || busy || !canOperate) return false;
    const payload = retry
      ? command
      : { ...command, id: commandId(), meetingId: snapshot.meetingId };
    setBusy(true);
    setError("");
    rememberPending({ command: payload, room: roomId });
    try {
      const result = await api(`/api/studio/rooms/${roomId}/commands`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      rememberPending(undefined);
      if (result.taskIds) {
        setCreateOpen(false);
        setSelectedId(result.taskIds[0]);
        if (result.taskIds[1]) setCompareId(result.taskIds[1]);
      }
      setNotice(
        result.type === "confirmed"
          ? "この版を試した記録を残しました。"
          : result.type === "cancelled"
            ? "作業を停止しました。"
            : "受け付けました。",
      );
      setRefresh((value) => value + 1);
      return true;
    } catch (failure) {
      const problem = failure as Error & { status?: number };
      setError(
        problem.status
          ? problem.message
          : "送信結果を確認できませんでした。同じ送信を再試行できます。",
      );
      if (problem.status && problem.status < 500 && problem.status !== 429)
        rememberPending(undefined);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const taskCommand = (type: string): Command => ({
    type,
    taskId: task?.id,
    specRevision: task?.specRevision,
    controlVersion: task?.controlVersion,
    runRevision: task?.runRevision,
  });
  async function submitDraft(event: FormEvent) {
    event.preventDefault();
    const value = draft.trim();
    if (!value) return;
    const command =
      composerMode === "follow"
        ? { ...(draftTarget ?? taskCommand("follow")), text: value }
        : { type: "say", text: value, ask: composerMode === "ask" };
    if (await send(command)) {
      setDraft("");
      setDraftTarget(undefined);
    }
  }
  async function create(event: FormEvent) {
    event.preventDefault();
    if (
      await send({
        type: variants ? "variants" : "create",
        title,
        text: request,
        criteria,
        variantA,
        variantB,
      })
    ) {
      setCreateOpen(false);
      setTitle("");
      setRequest("");
      setCriteria("");
      setVariantA("");
      setVariantB("");
      setVariants(false);
      setPane("spec");
    }
  }
  async function disconnect() {
    try {
      await api("/api/studio/logout", { method: "POST", body: "{}" });
    } catch {
      /* the local session is removed below */
    }
    sessionStorage.removeItem(tokenKey);
    setToken("");
    setSnapshot(undefined);
    setConnected(false);
    setError("");
  }
  const completed =
    snapshot?.tasks.filter((item) => item.state === "completed").length ?? 0;
  if (!token)
    return (
      <div className="studio studio-entry">
        <header className="entry-brand">
          <span className="ido-mark">
            <span />
          </span>
          <span>
            井戸<span className="brand-en"> / STUDIO</span>
          </span>
        </header>
        <main className="entry-main">
          <section className="entry-copy">
            <p className="eyebrow">TALK IT INTO SOMETHING REAL</p>
            <h1>
              話していたことが、
              <br />
              <span>目の前で動きだす。</span>
            </h1>
            <p>
              会話からつくる。触ってみる。その場で直す。
              <br />
              チームとCodexが、同じ成果を囲む場所です。
            </p>
            <div className="entry-cycle">
              <span>
                <MessageCircle size={18} />
                話す
              </span>
              <ArrowRight size={16} />
              <span>
                <Circle size={18} />
                つくる
              </span>
              <ArrowRight size={16} />
              <span>
                <Monitor size={18} />
                試す
              </span>
            </div>
          </section>
          <form className="connection-card" onSubmit={login}>
            <div className="connection-icon">
              <Unplug size={25} />
            </div>
            <h2>チームのエンジンにつなぐ</h2>
            <p>ホストが起動したエンジンの接続コードを入力してください。</p>
            <label>
              表示名
              <input
                autoComplete="nickname"
                maxLength={40}
                placeholder="チームに表示する名前"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <label>
              接続コード
              <input
                type="password"
                autoComplete="off"
                required
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="ホストから受け取ったコード"
              />
            </label>
            {error && (
              <p className="studio-error" role="alert">
                {error}
              </p>
            )}
            <button className="button-primary" disabled={busy}>
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <ArrowRight size={18} />
              )}
              共有スタジオに入る
            </button>
            <small>
              <ShieldCheck size={14} />
              閲覧用コードでは作業の実行・変更はできません。
            </small>
          </form>
        </main>
        <footer className="entry-footer">
          <span>CONVERSATION → CODEX → WORKING SOFTWARE</span>
          <span>同じ会話。同じ成果。次の一手。</span>
        </footer>
      </div>
    );

  return (
    <div className={`studio studio-room ${stage ? "is-stage" : ""}`}>
      <header className="studio-header">
        <a className="studio-brand" href="/studio" aria-label="共有スタジオ">
          <span className="ido-mark">
            <span />
          </span>
          <b>井戸</b>
          <span>STUDIO</span>
        </a>
        <div className="room-picker">
          <label className="sr-only" htmlFor="room-select">
            プロジェクト
          </label>
          <select
            id="room-select"
            value={roomId}
            disabled={busy}
            onChange={(event) => {
              setRoomId(event.target.value);
              setError("");
            }}
          >
            <option value="" disabled>
              プロジェクトを読み込み中
            </option>
            {rooms.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </div>
        <div className="studio-connection" role="status">
          <span
            className={connected ? "connection-dot" : "connection-dot offline"}
          />
          {connected ? "エンジン接続中" : "再接続中"}
        </div>
        <div className="header-actions">
          <button
            className="icon-button"
            aria-label="接続と共有"
            onClick={() => void showConnection()}
          >
            <Settings2 size={18} />
          </button>
          <button
            className="button-quiet"
            onClick={() => setStage(!stage)}
            title={stage ? "通常画面に戻る" : "発表画面"}
          >
            {stage ? <PanelRightClose size={18} /> : <Maximize2 size={18} />}
            <span>{stage ? "通常画面" : "発表画面"}</span>
          </button>
          <button
            className="icon-button"
            aria-label="接続を解除"
            onClick={() => void disconnect()}
          >
            <Unplug size={18} />
          </button>
        </div>
      </header>
      {error && !createOpen && (
        <div className="studio-banner" role="alert">
          <span>{error}</span>
          {pending && pending.room === roomId ? (
            <button
              disabled={busy || !canOperate}
              onClick={() => void send(pending.command, true)}
            >
              同じ送信を再試行
            </button>
          ) : (
            <button
              onClick={() => {
                setError("");
                setRefresh((value) => value + 1);
              }}
            >
              最新の状態を確認
            </button>
          )}
          <button
            className="icon-button"
            aria-label="通知を閉じる"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className="studio-workspace">
        <nav className="task-rail" aria-label="つくっているもの">
          <div className="rail-heading">
            <span>つくっているもの</span>
            <span>{snapshot?.tasks.length ?? 0}</span>
          </div>
          <button
            className="new-task"
            disabled={!canOperate}
            onClick={() => setCreateOpen(true)}
          >
            <Plus size={18} />
            新しくつくる
          </button>
          <div className="task-list">
            {snapshot?.tasks
              .slice()
              .reverse()
              .map((item) => (
                <button
                  key={item.id}
                  className={`task-item ${selectedId === item.id ? "selected" : ""}`}
                  onClick={() => {
                    setSelectedId(item.id);
                    if (compareId === item.id) setCompareId("");
                  }}
                >
                  <span className={`task-state-dot ${item.state}`} />
                  <strong>{item.title}</strong>
                  <span>{stateLabel[item.state] ?? item.state}</span>
                  <small>
                    仕様 {item.specRevision} · 実行 {item.runRevision || "—"}
                  </small>
                </button>
              ))}
          </div>
          <div className="rail-footer">
            <Radio size={15} />
            <span>
              {running
                ? `${running} 件の作業が進行中`
                : "次のアイデアを待っています"}
            </span>
          </div>
        </nav>
        <main className="artifact-main">
          <div className="artifact-heading">
            <div>
              <p className="eyebrow">
                {stage ? "FROM CONVERSATION TO REALITY" : "SHARED ARTIFACT"}
              </p>
              <h1>{task?.title ?? "ここで、アイデアが動きだす。"}</h1>
              <p>
                {task ? (
                  <>
                    <span className={`state-chip ${task.state}`}>
                      {["queued", "running"].includes(task.state) && (
                        <LoaderCircle className="spin" size={12} />
                      )}
                      {stateLabel[task.state] ?? task.state}
                    </span>
                    <span className="revision-label">
                      仕様 {task.specRevision} / 実行 {task.runRevision || "—"}
                    </span>
                  </>
                ) : (
                  "会話で方向を合わせて、最初のひとつをつくりましょう。"
                )}
              </p>
            </div>
            {task && (
              <div className="artifact-controls">
                <button
                  className={`icon-button ${mobilePreview ? "active" : ""}`}
                  aria-label="スマートフォン幅で表示"
                  aria-pressed={mobilePreview}
                  onClick={() => setMobilePreview(!mobilePreview)}
                >
                  <Smartphone size={18} />
                </button>
                <label className="compare-picker">
                  <GitCompareArrows size={17} />
                  <span className="sr-only">比較する成果</span>
                  <select
                    aria-label="比較する成果"
                    value={compareId}
                    onChange={(event) => setCompareId(event.target.value)}
                  >
                    <option value="">比較する</option>
                    {snapshot?.tasks
                      .filter((item) => item.id !== task.id)
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.title}
                        </option>
                      ))}
                  </select>
                </label>
              </div>
            )}
          </div>
          {!task ? (
            <section className="artifact-empty">
              <div className="empty-orbit">
                <span className="ido-mark">
                  <span />
                </span>
                <i />
                <i />
              </div>
              <h2>まず、何をつくりますか。</h2>
              <p>
                右の会話欄で考えを共有できます。
                <br />
                方向が決まったら、Codexに制作を依頼してください。
              </p>
              <button
                className="button-primary"
                disabled={!canOperate}
                onClick={() => setCreateOpen(true)}
              >
                <Plus size={18} />
                最初の成果をつくる
              </button>
              <div className="empty-capabilities">
                <span>実際に操作できるプレビュー</span>
                <span>同じ作業への追加指示</span>
                <span>二つの案を並べて比較</span>
              </div>
            </section>
          ) : (
            <>
              <div
                className={`preview-grid ${comparison ? "is-comparing" : ""} ${mobilePreview ? "phone-width" : ""}`}
              >
                <Artifact
                  task={task}
                  label={comparison ? "A" : undefined}
                  connected={connected}
                />
                {comparison && (
                  <Artifact task={comparison} label="B" connected={connected} />
                )}
              </div>
              <div className="artifact-bottom">
                <div className="verification-line">
                  <ShieldCheck size={17} />
                  <span>
                    {currentPreview(task)?.browserVerified
                      ? "ブラウザ操作を自動確認済み"
                      : currentPreview(task)
                        ? "プレビューを操作して確かめてください"
                        : ["running", "queued"].includes(task.state)
                          ? "この版のプレビューを準備しています"
                          : "現在開けるプレビューはありません"}
                  </span>
                  {currentPreview(task)?.confirmations.length ? (
                    <span className="people-tested">
                      <CheckCheck size={15} />
                      {currentPreview(task)!.confirmations.length}{" "}
                      接続が試しました
                    </span>
                  ) : null}
                </div>
                <div className="artifact-bottom-actions">
                  {task.state === "completed" && !currentPreview(task)?.url && (
                    <button
                      className="button-secondary"
                      disabled={!canOperate || busy}
                      onClick={() => void send(taskCommand("preview"))}
                    >
                      <RefreshCw size={16} />
                      プレビューを開き直す
                    </button>
                  )}
                  <button
                    className="button-secondary"
                    disabled={
                      !canOperate ||
                      busy ||
                      !currentPreview(task)?.url ||
                      task.state !== "completed"
                    }
                    onClick={() => void send(taskCommand("confirm"))}
                  >
                    <Check size={16} />
                    この版を試した
                  </button>
                  <button
                    className="button-secondary"
                    disabled={!canOperate || busy}
                    onClick={() => {
                      setComposerMode("follow");
                      setDraftTarget(taskCommand("follow"));
                      setPane("conversation");
                      document.getElementById("studio-composer")?.focus();
                    }}
                  >
                    <MessageCircle size={16} />
                    ここを直したい
                  </button>
                  {["running", "queued"].includes(task.state) && (
                    <button
                      className="button-danger"
                      disabled={!canOperate || busy}
                      onClick={() => void send(taskCommand("stop"))}
                    >
                      <Square size={13} />
                      停止
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
          {stage && (
            <div className="stage-story">
              <span>
                <MessageCircle size={17} />
                会話で方向を決める
              </span>
              <ArrowRight size={16} />
              <span>
                <Circle size={17} />
                Codexがつくって確かめる
              </span>
              <ArrowRight size={16} />
              <span>
                <Monitor size={17} />
                全員で触って、直す
              </span>
              <b>{completed} 件の成果</b>
            </div>
          )}
        </main>
        <aside className="conversation-panel">
          <div
            className="panel-tabs"
            role="tablist"
            aria-label="共有コンテキスト"
          >
            {(
              [
                ["conversation", "会話"],
                ["spec", "仕様"],
                ["activity", "動き"],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                id={`tab-${id}`}
                role="tab"
                aria-selected={pane === id}
                aria-controls={`panel-${id}`}
                onClick={() => setPane(id)}
              >
                {label}
                {id === "activity" && running > 0 && (
                  <span className="small-pulse" />
                )}
              </button>
            ))}
          </div>
          <div
            className="panel-content"
            id={`panel-${pane}`}
            role="tabpanel"
            aria-labelledby={`tab-${pane}`}
          >
            {pane === "conversation" && (
              <>
                <div className="conversation-intro">
                  <span className="connection-dot" />
                  <p>この部屋の会話が、制作の文脈になります。</p>
                </div>
                {snapshot?.statements.length ? (
                  snapshot.statements.map((statement, index) => (
                    <article
                      className="statement"
                      key={`${statement.id ?? statement.sequence}-${index}`}
                    >
                      <span className="speaker-avatar">
                        {statement.speaker.slice(0, 1)}
                      </span>
                      <div>
                        <header>
                          <strong>{statement.speaker}</strong>
                          <time>{formatTime(statement.at)}</time>
                        </header>
                        <p>{statement.text}</p>
                      </div>
                    </article>
                  ))
                ) : (
                  <div className="panel-empty">
                    <MessageCircle size={27} />
                    <p>
                      まだ会話はありません。
                      <br />
                      どんなものが欲しいか、話してみましょう。
                    </p>
                  </div>
                )}
              </>
            )}
            {pane === "spec" &&
              (task ? (
                <div className="spec-content">
                  <p className="eyebrow">仕様 {task.specRevision}</p>
                  {task.instructions.length > 0 && (
                    <>
                      <h2>最新の指示</h2>
                      <p className="muted">
                        変更した点は、この指示を優先します。
                      </p>
                      {task.instructions.slice(-1).map((instruction, index) => (
                        <div className="spec-change" key={index}>
                          <small>仕様 {instruction.specRevision ?? "—"}</small>
                          <p>{instruction.text}</p>
                        </div>
                      ))}
                    </>
                  )}
                  <details open={!task.instructions.length}>
                    <summary>最初の依頼と条件</summary>
                    <h3>最初の依頼</h3>
                    <p className="preserve-lines">{task.request}</p>
                    <h3>最初に指定した条件</h3>
                    {task.acceptanceCriteria.length ? (
                      <ul className="criteria-list">
                        {task.acceptanceCriteria.map((criterion, index) => (
                          <li key={index}>
                            <Circle size={13} />
                            <span>{criterion}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="muted">
                        個別の条件はまだ指定されていません。
                      </p>
                    )}
                  </details>
                  {task.instructions.length > 1 && (
                    <details>
                      <summary>それまでの追加指示</summary>
                      {task.instructions
                        .slice(0, -1)
                        .map((instruction, index) => (
                          <div className="spec-change" key={index}>
                            <small>
                              仕様 {instruction.specRevision ?? "—"}
                            </small>
                            <p>{instruction.text}</p>
                          </div>
                        ))}
                    </details>
                  )}
                  <h3>届いた結果</h3>
                  {task.result ? (
                    <>
                      <p className="muted">
                        仕様 {task.resultSpecRevision ?? "未確認"} / 実行{" "}
                        {task.resultRunRevision ?? "未確認"}
                        {task.resultSpecRevision !== task.specRevision
                          ? " · 現在の仕様への反映は未確認"
                          : ""}
                      </p>
                      <p className="preserve-lines result-text">
                        {task.result}
                      </p>
                    </>
                  ) : (
                    <p className="muted">結果が届くとここに表示します。</p>
                  )}
                  {task.verification && (
                    <details>
                      <summary>検証の記録</summary>
                      <p className="preserve-lines">{task.verification}</p>
                    </details>
                  )}
                </div>
              ) : (
                <div className="panel-empty">
                  <Clipboard size={27} />
                  <p>成果を選ぶと、その仕様を確認できます。</p>
                </div>
              ))}
            {pane === "activity" && (
              <div className="activity-list">
                <p className="panel-note">エンジンが実際に処理した記録です。</p>
                {snapshot?.activity
                  .filter(
                    (event) =>
                      !task || event.taskId === task.id || !event.taskId,
                  )
                  .slice(-25)
                  .reverse()
                  .map((event) => (
                    <article key={event.sequence}>
                      <span
                        className={
                          event.status === "running"
                            ? "activity-dot running"
                            : "activity-dot"
                        }
                      />
                      <div>
                        <header>
                          <strong>
                            {stageName[event.stage] ?? event.stage}
                          </strong>
                          <time>{formatTime(event.at)}</time>
                        </header>
                        <p>
                          {event.summary ||
                            event.text ||
                            event.tool ||
                            ({
                              running: "処理中",
                              waiting: "待機中",
                              completed: "処理完了",
                              failed: "処理に失敗",
                              interrupted: "中断",
                              skipped: "処理を省略",
                            }[event.status] ??
                              event.status)}
                        </p>
                      </div>
                    </article>
                  ))}
              </div>
            )}
          </div>
          {!stage && (
            <form className="studio-composer" onSubmit={submitDraft}>
              <div className="composer-top">
                <label>
                  <span className="sr-only">送信先</span>
                  <select
                    value={composerMode}
                    onChange={(event) => {
                      setComposerMode(
                        event.target.value as typeof composerMode,
                      );
                      setDraftTarget(
                        event.target.value === "follow"
                          ? taskCommand("follow")
                          : undefined,
                      );
                    }}
                  >
                    <option value="say">みんなに話す</option>
                    <option value="ask">Codexに聞く・頼む</option>
                    <option value="follow" disabled={!task}>
                      選んだ成果を修正
                    </option>
                  </select>
                </label>
                <span>
                  {actor?.name}
                  {actor?.role === "viewer" ? " · 閲覧のみ" : ""}
                </span>
              </div>
              <textarea
                id="studio-composer"
                aria-label={
                  composerMode === "follow" ? "追加の指示" : "会話への発言"
                }
                value={draft}
                onChange={(event) => {
                  setDraft(event.target.value);
                  if (composerMode === "follow" && !draftTarget)
                    setDraftTarget(taskCommand("follow"));
                }}
                placeholder={
                  composerMode === "follow"
                    ? "例：隠すのではなく、準備中を下に並べて"
                    : composerMode === "ask"
                      ? "例：今の会話をもとに、案内ページをつくって"
                      : "例：スマートフォンで使えると嬉しい"
                }
                maxLength={6000}
                rows={3}
                disabled={actor?.role === "viewer"}
              />
              <div className="composer-bottom">
                <small>
                  {composerMode === "follow"
                    ? `仕様 ${draftTarget?.specRevision ?? task?.specRevision ?? "—"} に追加します`
                    : composerMode === "ask"
                      ? "明示的な呼びかけとして届けます"
                      : "呼びかけがなければ会話を見守ります"}
                </small>
                <button
                  className="send-button"
                  aria-label="送信"
                  disabled={
                    !canOperate ||
                    busy ||
                    !draft.trim() ||
                    (composerMode === "follow" &&
                      (!task ||
                        (draftTarget && draftTarget.taskId !== task.id)))
                  }
                >
                  {busy ? (
                    <LoaderCircle className="spin" size={17} />
                  ) : (
                    <Send size={17} />
                  )}
                </button>
              </div>
            </form>
          )}
        </aside>
      </div>
      <div className="studio-toast" role="status">
        {notice}
      </div>
      <dialog
        className="create-dialog connection-dialog"
        ref={connectionDialog}
        onCancel={() => setConnectionOpen(false)}
        onClose={() => setConnectionOpen(false)}
      >
        <header>
          <div>
            <p className="eyebrow">ENGINE & TEAM</p>
            <h2>接続と共有</h2>
          </div>
          <button
            className="icon-button"
            aria-label="閉じる"
            onClick={() => setConnectionOpen(false)}
          >
            <X size={20} />
          </button>
        </header>
        <p className="dialog-intro">
          同じエンジンを使う人に、用途に合うリンクを渡せます。
        </p>
        <dl className="connection-facts">
          <div>
            <dt>プロジェクト</dt>
            <dd>{rooms.find((room) => room.id === roomId)?.name}</dd>
          </div>
          <div>
            <dt>エンジン</dt>
            <dd>{location.origin}</dd>
          </div>
          <div>
            <dt>あなたの接続</dt>
            <dd>
              {actor?.name} ·{" "}
              {actor?.role === "operator" ? "操作できます" : "閲覧のみ"}
            </dd>
          </div>
        </dl>
        {invites && (
          <>
            {invites.operator && (
              <label>
                一緒につくる人のリンク
                <div className="invite-link">
                  <input
                    readOnly
                    value={invites.operator}
                    onFocus={(event) => event.target.select()}
                    aria-label="操作用の共有リンク"
                  />
                  <button
                    className="button-secondary"
                    onClick={() => void copyLink(invites.operator!)}
                  >
                    コピー
                  </button>
                </div>
                <small className="muted">
                  このリンクを持つ人は作業を開始・変更・停止できます。
                </small>
              </label>
            )}
            <label>
              見る人のリンク
              <div className="invite-link">
                <input
                  readOnly
                  value={invites.viewer}
                  onFocus={(event) => event.target.select()}
                  aria-label="閲覧用の共有リンク"
                />
                <button
                  className="button-secondary"
                  onClick={() => void copyLink(invites.viewer)}
                >
                  コピー
                </button>
              </div>
              <small className="muted">会話・仕様・成果を閲覧できます。</small>
            </label>
          </>
        )}
        <p className="connection-scope">
          {["localhost", "127.0.0.1"].includes(location.hostname)
            ? "現在はこのPC向けの接続です。別の端末で使う場合は、ホストがネットワーク共有を設定してください。"
            : "参加者の端末から、エンジンとプレビューの両方を開けるか確認してください。"}
        </p>
      </dialog>
      <dialog
        className="create-dialog"
        ref={createDialog}
        onCancel={() => setCreateOpen(false)}
        onClose={() => setCreateOpen(false)}
      >
        <form onSubmit={create}>
          <header>
            <div>
              <p className="eyebrow">LET'S MAKE IT REAL</p>
              <h2>何をつくりますか。</h2>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label="閉じる"
              onClick={() => setCreateOpen(false)}
            >
              <X size={20} />
            </button>
          </header>
          <p className="dialog-intro">
            ここまでの会話もCodexに伝わります。できたものを触りながら、後から変えられます。
          </p>
          {error && (
            <div className="studio-error" role="alert">
              <p>{error}</p>
              {pending && (
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy || !canOperate}
                  onClick={() => void send(pending.command, true)}
                >
                  同じ送信を再試行
                </button>
              )}
            </div>
          )}
          <label>
            成果の名前 <span className="muted">任意</span>
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={80}
              placeholder="例：ひらく展示"
            />
          </label>
          <label>
            実現したいこと
            <textarea
              autoFocus
              required
              rows={4}
              maxLength={6000}
              value={request}
              onChange={(event) => setRequest(event.target.value)}
              placeholder="誰のために、何ができるものをつくる？"
            />
          </label>
          <label>
            満たしたい条件 <span className="muted">任意・1行にひとつ</span>
            <textarea
              rows={3}
              maxLength={2000}
              value={criteria}
              onChange={(event) => setCriteria(event.target.value)}
              placeholder={"スマートフォンで使える\nログインなしで触れる"}
            />
          </label>
          <label className="variant-toggle">
            <input
              type="checkbox"
              checked={variants}
              onChange={(event) => setVariants(event.target.checked)}
            />
            <GitCompareArrows size={18} />
            <span>二つの案を並行してつくる</span>
          </label>
          {variants && (
            <div className="variant-inputs">
              <label>
                案 A
                <input
                  required
                  maxLength={1000}
                  value={variantA}
                  onChange={(event) => setVariantA(event.target.value)}
                  placeholder="例：一覧で探しやすく"
                />
              </label>
              <label>
                案 B
                <input
                  required
                  maxLength={1000}
                  value={variantB}
                  onChange={(event) => setVariantB(event.target.value)}
                  placeholder="例：地図から探しやすく"
                />
              </label>
            </div>
          )}
          <footer>
            <span>
              選択中：{rooms.find((room) => room.id === roomId)?.name}
            </span>
            <button
              className="button-primary"
              disabled={!canOperate || busy || !request.trim()}
            >
              {busy ? (
                <LoaderCircle className="spin" size={18} />
              ) : (
                <ArrowRight size={18} />
              )}
              {variants ? "二つの案をつくる" : "Codexにつくってもらう"}
            </button>
          </footer>
        </form>
      </dialog>
    </div>
  );
}

function Artifact({
  task,
  label,
  connected,
}: {
  task: StudioTask;
  label?: string;
  connected: boolean;
}) {
  const preview = currentPreview(task);
  const [loadedUrl, setLoadedUrl] = useState("");
  const [reload, setReload] = useState(0);
  const [copyStatus, setCopyStatus] = useState("");
  const url = preview?.url;
  const building = ["running", "queued"].includes(task.state);
  const copy = async () => {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopyStatus("リンクをコピーしました");
    } catch {
      setCopyStatus("別のタブで開き、アドレス欄からコピーしてください");
    }
  };
  return (
    <section className="artifact-frame">
      <div className="browser-bar">
        <div className="window-dots">
          <i />
          <i />
          <i />
        </div>
        <span>
          {label ? `案 ${label} · ` : ""}
          {url ? `実行 ${preview?.runRevision} のプレビュー` : "プレビュー"}
        </span>
        <div>
          {url && (
            <>
              <button
                className="icon-button"
                aria-label={`${label ?? "成果"}のプレビューを再読み込み`}
                onClick={() => setReload((value) => value + 1)}
              >
                <RefreshCw size={14} />
              </button>
              <button
                className="icon-button"
                aria-label={`${label ?? "成果"}のプレビューリンクをコピー`}
                onClick={() => void copy()}
              >
                <Clipboard size={14} />
              </button>
              <a
                className="icon-button"
                aria-label={`${label ?? "成果"}のプレビューを別のタブで開く`}
                href={url}
                target="_blank"
                rel="noreferrer"
              >
                <ExternalLink size={14} />
              </a>
            </>
          )}
        </div>
      </div>
      {copyStatus && <p role="status">{copyStatus}</p>}
      {url ? (
        <div className="iframe-wrap">
          {loadedUrl !== url && (
            <div className="preview-loading">
              <LoaderCircle className="spin" size={22} />
              <p>プレビューに接続しています</p>
            </div>
          )}
          <iframe
            key={`${url}:${reload}`}
            title={`${label ? `案 ${label} ` : ""}${task.title}のプレビュー`}
            src={url}
            sandbox="allow-scripts allow-same-origin allow-forms"
            referrerPolicy="no-referrer"
            onLoad={() => setLoadedUrl(url)}
          />
        </div>
      ) : (
        <div className={`preview-placeholder ${building ? "building" : ""}`}>
          <div className="preview-symbol">
            {building ? (
              <LoaderCircle className="spin" size={30} />
            ) : task.state === "completed" ? (
              <Check size={30} />
            ) : (
              <Monitor size={30} />
            )}
          </div>
          <p className="eyebrow">
            {building ? "CODEX IS WORKING" : "WORKSPACE"}
          </p>
          <h2>
            {building
              ? "会話を、かたちにしています。"
              : task.state === "completed"
                ? "作業の結果が届いています。"
                : task.state === "cancelled"
                  ? "この作業は停止しました。"
                  : "続きを、ここから。"}
          </h2>
          <p>
            {building
              ? "同じ成果への追加指示も、今のうちに送れます。"
              : task.state === "completed"
                ? task.preview?.state === "failed"
                  ? "プレビューの起動を確認できませんでした。仕様タブで結果を確認し、修正を依頼できます。"
                  : "仕様タブで結果を確認できます。プレビューの設定・状態も確認してください。"
                : "仕様と会話を残したまま、追加の指示で再開できます。"}
          </p>
          {building && (
            <div className="build-track">
              <span className="done">
                <Check size={13} />
                依頼を受け付け
              </span>
              <span className="current">制作・確認</span>
              <span>みんなに共有</span>
            </div>
          )}
        </div>
      )}
      {!connected && (
        <div className="preview-stale">
          エンジンとの接続が切れています。この表示の更新状況は未確認です。
        </div>
      )}
    </section>
  );
}
