import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Mic,
  FileText,
  List,
  MessagesSquare,
  Cpu,
  Layers,
  Package,
  Volume2,
  Radio,
  Search,
  X,
} from "lucide-react";
import { Switch } from "./components/ui/switch";
import { append, spans, type Snapshot, type Observation } from "./model";
import "./style.css";

const stages = [
  "AUDIO",
  "STT",
  "ASSEMBLE",
  "OBSERVE",
  "QUEUE",
  "EXECUTE",
  "DELIVER",
  "TTS",
  "PLAYBACK",
];
const names: Record<string, string> = {
  AUDIO: "音声入力",
  STT: "音声認識",
  ASSEMBLE: "発話組立",
  OBSERVE: "会話観測",
  QUEUE: "タスク待機",
  EXECUTE: "タスク実行",
  DELIVER: "結果配送",
  TTS: "音声合成",
  PLAYBACK: "音声再生",
  IMMEDIATE: "即時応答",
};
const labels: Record<string, string> = {
  running: "実行中",
  waiting: "待機",
  completed: "完了",
  failed: "失敗",
  interrupted: "中断",
  skipped: "スキップ",
};
const reasons: Record<string, string> = {
  transcription_capacity: "STTの空き待ち",
  execution_capacity: "実行枠待ち",
  playback_queue: "読み上げ待ち",
  turn_queue: "前の応答待ち",
  timeout: "タイムアウト",
  aborted: "中断要求",
  operation_failed: "処理失敗",
  service_stopped: "サービス停止",
  speaker_silence: "話者の発話終了待ち",
  receipt_pending: "受付の保存待ち",
  transcript_unavailable: "認識テキストなし",
  completion_unprovided: "完了情報は未提供",
  transcript_segments: "発話の認識・区切り待ち",
  live_playback_unprovided: "Live音声の再生完了情報は未提供",
};
const icons = [
  Mic,
  FileText,
  List,
  MessagesSquare,
  Layers,
  Cpu,
  Package,
  Volume2,
  Radio,
];
const shortId = (id: string) =>
  id.includes(":I-") ? id.split(":").at(-1)! : id;
function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>({
    sessionId: "",
    sequence: 0,
    events: [],
  });
  const [connection, setConnection] = useState("connecting");
  const [hidden, setHidden] = useState(false);
  const [selection, select] = useState<{ task?: string; input?: string }>({});
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let stopped = false,
      source: EventSource | undefined,
      retry: ReturnType<typeof setTimeout>;
    let controller: AbortController,
      generation = 0,
      lastReceived = Date.now();
    const sync = async () => {
      if (stopped) return;
      const current = ++generation;
      clearTimeout(retry);
      source?.close();
      controller?.abort();
      controller = new AbortController();
      const valid = () => !stopped && current === generation;
      try {
        const response = await fetch("/api/snapshot", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("snapshot");
        let state: Snapshot = await response.json();
        if (!valid()) return;
        setSnapshot(state);
        source = new EventSource(
          `/api/events?after=${state.sequence}&session=${encodeURIComponent(state.sessionId)}`,
        );
        source.onopen = () => {
          if (valid()) {
            lastReceived = Date.now();
            setConnection("live");
          }
        };
        source.onerror = () => {
          if (valid()) {
            setConnection("offline");
            source?.close();
            retry = setTimeout(sync, 2000);
          }
        };
        source.addEventListener("heartbeat", () => {
          if (valid()) lastReceived = Date.now();
        });
        source.addEventListener("reset", () => {
          if (valid()) {
            setConnection("syncing");
            void sync();
          }
        });
        source.addEventListener("observation", (message) => {
          if (!valid()) return;
          lastReceived = Date.now();
          try {
            const next = append(state, JSON.parse(message.data));
            if (!next) {
              setConnection("syncing");
              void sync();
              return;
            }
            state = next;
            setSnapshot(next);
          } catch {
            setConnection("syncing");
            void sync();
          }
        });
      } catch {
        if (valid()) {
          setConnection("offline");
          retry = setTimeout(sync, 2000);
        }
      }
    };
    const offline = () => {
      generation++;
      source?.close();
      controller?.abort();
      clearTimeout(retry);
      setConnection("offline");
      retry = setTimeout(sync, 2000);
    };
    const online = () => {
      setConnection("syncing");
      void sync();
    };
    window.addEventListener("offline", offline);
    window.addEventListener("online", online);
    void sync();
    const clock = setInterval(() => {
      setNow(Date.now());
      if (
        source?.readyState === EventSource.OPEN &&
        Date.now() - lastReceived > 35000
      )
        offline();
    }, 250);
    return () => {
      stopped = true;
      generation++;
      source?.close();
      controller?.abort();
      clearTimeout(retry);
      clearInterval(clock);
      window.removeEventListener("offline", offline);
      window.removeEventListener("online", online);
    };
  }, []);
  const all = spans([...(snapshot.active ?? []), ...snapshot.events]);
  const tasks = all.filter((e) => e.spanId === `task-${e.taskId}`);
  const relatedInputs = new Set(
    selection.task
      ? all
          .filter((e) => e.taskId === selection.task)
          .flatMap((e) => e.inputIds)
      : selection.input
        ? [selection.input]
        : [],
  );
  const relatedTasks = new Set(
    selection.input
      ? all
          .filter((e) => e.inputIds.includes(selection.input!))
          .map((e) => e.taskId)
      : selection.task
        ? [selection.task]
        : [],
  );
  const selected = (e: Observation) =>
    Boolean(
      (e.taskId && relatedTasks.has(e.taskId)) ||
      e.inputIds.some((id) => relatedInputs.has(id)),
    );
  const choose = (e: Observation) =>
    select(e.taskId ? { task: e.taskId } : { input: e.inputIds[0] });
  const body = (value?: string) => (hidden ? "••••" : value || "未提供");
  const elapsed = (e: (typeof all)[number]) =>
    `${(Math.max(0, (["running", "waiting"].includes(e.status) ? now : e.at) - e.start) / 1000).toFixed(1)}s`;
  const feed = all
    .filter((e) => ["ASSEMBLE", "DELIVER"].includes(e.stage) && e.text)
    .slice(-60)
    .reverse();
  const detail = all.filter((e) =>
    selection.task ? e.taskId === selection.task : selected(e),
  );
  const latest =
    tasks.find((e) => e.taskId === selection.task) ?? detail.at(-1);
  const tools = detail.filter((e) => e.tool);
  const intervals = all.filter((e) => e.spanId !== `task-${e.taskId}`);
  const active = intervals.filter((e) =>
    ["waiting", "running"].includes(e.status),
  );
  const card = (e: (typeof all)[number]) => (
    <button
      key={e.spanId ?? e.sequence}
      className={`event ${e.status} ${selected(e) ? "selected" : ""}`}
      onClick={() => choose(e)}
    >
      <strong>
        {e.taskId ?? (e.inputIds.map(shortId).join(" · ") || "処理")}
      </strong>
      {(e.title || e.tool) && <span>{body(e.title ?? e.tool)}</span>}
      <small>
        {["TTS", "PLAYBACK"].includes(e.stage) && `${names[e.stage]} · `}
        {labels[e.status]} · {elapsed(e)}
        {e.reason && ` · ${reasons[e.reason] ?? "未提供"}`}
      </small>
    </button>
  );
  const positions = [
    [30, 35],
    [300, 35],
    [570, 35],
    [840, 35],
    [840, 295],
    [570, 295],
    [300, 295],
    [30, 295],
  ];
  const timeline = (
    selection.task || selection.input ? intervals.filter(selected) : intervals
  ).slice(-30);
  const start = Math.min(...timeline.map((e) => e.start), now),
    end = Math.max(
      start + 1000,
      ...timeline.map((e) =>
        ["running", "waiting"].includes(e.status) ? now : e.at,
      ),
    );
  return (
    <div className="app">
      <header>
        <div className="brand">
          VOICE ENGINE <span>LIVE OBSERVATORY</span>
        </div>
        <div className="metrics">
          <span className={`connection ${connection}`}>
            <i />
            {
              {
                live: "接続中",
                offline: "通信断",
                connecting: "接続待ち",
                syncing: "再同期中",
              }[connection]
            }
          </span>
          <span>
            実行{" "}
            <b>
              {tasks
                .filter((e) => e.status === "running")
                .length.toString()
                .padStart(2, "0")}
            </b>
          </span>
          <span>
            待機{" "}
            <b>
              {tasks
                .filter((e) => e.status === "waiting")
                .length.toString()
                .padStart(2, "0")}
            </b>
          </span>
          <label>
            <Switch
              checked={hidden}
              onCheckedChange={setHidden}
              aria-label="本文を隠す"
            />{" "}
            本文を隠す
          </label>
        </div>
      </header>
      {connection !== "live" && (
        <div className="connection-banner">
          {snapshot.events.length
            ? "通信断・再同期中：表示は最後に受信した状態です。処理停止を意味しません。"
            : "ライブ接続待ち — 実データはまだ受信していません。"}
        </div>
      )}
      <main>
        <aside className="feed">
          <h2>
            INPUT <span>会話フィード</span>
          </h2>
          <div className="feed-scroll">
            {feed.length ? (
              feed.map((e) => (
                <button
                  key={e.spanId ?? e.sequence}
                  className={`feed-card ${e.status} ${selected(e) ? "selected" : ""}`}
                  onClick={() => choose(e)}
                >
                  <div>
                    <strong>
                      {e.inputIds.map(shortId).join(" · ") ||
                        e.taskId ||
                        "OUTPUT"}
                    </strong>
                    <time>
                      {new Date(e.at).toLocaleTimeString("ja-JP", {
                        hour12: false,
                      })}
                    </time>
                  </div>
                  <small>
                    {e.stage === "DELIVER" ? "応答" : body(e.speaker)}
                  </small>
                  <p>{body(e.text)}</p>
                  <footer>
                    {tasks
                      .filter((t) =>
                        t.inputIds.some((id) => e.inputIds.includes(id)),
                      )
                      .map((t) => (
                        <span key={t.taskId}>
                          {t.taskId} → {labels[t.status]}
                        </span>
                      ))}
                  </footer>
                </button>
              ))
            ) : (
              <div className="empty">
                発話を待っています
                <span>音声とテキストの到着後に表示されます</span>
              </div>
            )}
          </div>
        </aside>
        <section className="flow">
          <h2>
            FLOW <span>処理の流れ</span>
            <small>{active.length} ACTIVE INTERVALS</small>
          </h2>
          <div className="flow-canvas">
            <svg
              viewBox="0 0 1100 520"
              role="img"
              aria-label="処理フローと即時応答の分岐"
            >
              <defs>
                <marker
                  id="arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#14d7ff" />
                </marker>
              </defs>
              <g className="wires" markerEnd="url(#arrow)">
                <path d="M250 120H295" />
                <path d="M520 120H565" />
                <path d="M790 120H835" />
                <path d="M950 205V290" />
                <path d="M840 380H795" />
                <path d="M570 380H525" />
                <path d="M300 380H255" />
                <path d="M870 205V245H400V290" />
              </g>
              <foreignObject x="565" y="220" width="240" height="65">
                <div className="immediate-box">
                  <small>IMMEDIATE · 即時応答</small>
                  {all
                    .filter((e) => e.stage === "IMMEDIATE")
                    .slice(-1)
                    .map(card)}
                </div>
              </foreignObject>
              {positions.map(([x, y], i) => {
                const Icon = icons[i],
                  events = all.filter(
                    (e) =>
                      (e.stage === stages[i] ||
                        (stages[i] === "TTS" && e.stage === "PLAYBACK")) &&
                      (e.taskId && ["QUEUE", "EXECUTE"].includes(e.stage)
                        ? e.spanId === `task-${e.taskId}` || !!e.tool
                        : true),
                  );
                const visible = [
                  ...events.filter((e) =>
                    ["running", "waiting"].includes(e.status),
                  ),
                  ...events
                    .filter((e) => !["running", "waiting"].includes(e.status))
                    .slice(-2),
                ];
                return (
                  <foreignObject
                    key={stages[i]}
                    x={x}
                    y={y}
                    width="220"
                    height="170"
                  >
                    <div className="stage">
                      <h3>
                        <Icon size={19} />
                        {stages[i] === "TTS" ? "音声出力" : names[stages[i]]}
                        <small>
                          {stages[i] === "TTS" ? "TTS / PLAYBACK" : stages[i]}
                        </small>
                      </h3>
                      <div className="stage-events">
                        {visible.length ? (
                          visible.map(card)
                        ) : (
                          <div className="slot">イベントなし</div>
                        )}
                      </div>
                    </div>
                  </foreignObject>
                );
              })}
            </svg>
            <div className="legend">
              <span className="running">● 実行</span>
              <span className="waiting">● 待機</span>
              <span className="failed">● 失敗</span>
              <span>○ 完了 / 中断 / スキップ</span>
            </div>
          </div>
        </section>
        <aside className="detail">
          <h2>
            TASK DETAIL{" "}
            <button aria-label="選択解除" onClick={() => select({})}>
              <X size={17} />
            </button>
          </h2>
          {latest ? (
            <>
              <h3>{selection.task ?? shortId(selection.input ?? "")}</h3>
              <p>{body(detail.find((e) => e.title)?.title)}</p>
              <div className="chips">
                {[...relatedInputs].map((id) => (
                  <button key={id} onClick={() => select({ input: id })}>
                    {shortId(id)}
                  </button>
                ))}
              </div>
              <div className="detail-state">
                {labels[latest.status]} · {elapsed(latest)}
                <small>
                  {reasons[latest.reason ?? ""] ?? "待機理由：未提供"}
                </small>
              </div>
              <h4>
                <Search size={15} /> 検索 / ツール
              </h4>
              {tools.length ? (
                tools.map((e) => (
                  <div className="tool" key={e.spanId}>
                    <strong>{body(e.tool)}</strong>
                    <span>
                      {labels[e.status]} · {elapsed(e)}
                    </span>
                    <small>QUERY</small>
                    <p>{body(e.query)}</p>
                    <small>RESULT SUMMARY</small>
                    <p>{body(e.summary)}</p>
                    <small>RUN {e.runId ?? "未提供"}</small>
                  </div>
                ))
              ) : (
                <div className="empty">
                  詳細未提供<span>SDKから届いた検索情報だけを表示します</span>
                </div>
              )}
            </>
          ) : (
            <div className="empty">
              発話・タスクを選択<span>関連する処理区間と検索詳細を表示</span>
            </div>
          )}
        </aside>
      </main>
      <section className="timeline">
        <h2>
          TIMELINE <span>発話・タスク別の処理区間</span>
          <small>直近1,000イベント · メモリのみ</small>
        </h2>
        <div className="timeline-scroll">
          {timeline.length ? (
            <svg
              viewBox={`0 0 1400 ${timeline.length * 28 + 25}`}
              aria-label="処理タイムライン"
            >
              {timeline.map((e, i) => (
                <g
                  key={e.spanId ?? e.sequence}
                  role="button"
                  tabIndex={0}
                  aria-label={`${e.taskId ?? e.inputIds.map(shortId).join(" ")} ${e.stage} ${labels[e.status]}`}
                  onClick={() => choose(e)}
                  onKeyDown={(event) => {
                    if (["Enter", " "].includes(event.key)) {
                      event.preventDefault();
                      choose(e);
                    }
                  }}
                  className={selected(e) ? "selected-row" : ""}
                >
                  <text x="8" y={i * 28 + 20}>
                    {(
                      e.taskId ??
                      (e.inputIds.map(shortId).join(" ") || "処理")
                    ).slice(0, 28)}{" "}
                    · {e.stage}
                  </text>
                  <rect
                    className={e.status}
                    x={310 + ((e.start - start) / (end - start)) * 850}
                    y={i * 28 + 7}
                    width={Math.max(
                      4,
                      (((["running", "waiting"].includes(e.status)
                        ? now
                        : e.at) -
                        e.start) /
                        (end - start)) *
                        850,
                    )}
                    height="13"
                    rx="3"
                  />
                  <text x="1180" y={i * 28 + 20}>
                    {labels[e.status]} · {elapsed(e)}
                  </text>
                </g>
              ))}
            </svg>
          ) : (
            <div className="empty">処理区間はまだありません</div>
          )}
        </div>
      </section>
      <footer className="statusbar">
        <span>LOCALHOST · READ ONLY</span>
        <span>
          SESSION {snapshot.sessionId ? snapshot.sessionId.slice(0, 8) : "—"}　
          EVENT {snapshot.sequence.toString().padStart(6, "0")}
        </span>
      </footer>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
