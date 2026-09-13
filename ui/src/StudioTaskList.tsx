import { useState } from "react";
import { Plus, Radio, Search, X } from "lucide-react";
import { stateLabel, type StudioTask } from "./studio-model";
const groups: Record<string, string[]> = {
  working: ["queued", "running"],
  completed: ["completed"],
  paused: ["failed", "interrupted", "cancelled"],
};
export function StudioTaskList({
  tasks,
  selectedId,
  canOperate,
  onCreate,
  onSelect,
}: {
  tasks: StudioTask[];
  selectedId: string;
  canOperate: boolean;
  onCreate: () => void;
  onSelect: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const visible = tasks
    .filter(
      (item) =>
        (!groups[filter] || groups[filter].includes(item.state)) &&
        terms.every((term) =>
          `${item.title} ${item.request}`.toLocaleLowerCase().includes(term),
        ),
    )
    .slice()
    .reverse();
  const running = tasks.filter((item) =>
    groups.working.includes(item.state),
  ).length;
  return (
    <nav className="task-rail" aria-label="つくっているもの">
      <div className="rail-heading">
        <span>つくっているもの</span>
        <span>{tasks.length}</span>
      </div>
      <button className="new-task" disabled={!canOperate} onClick={onCreate}>
        <Plus size={18} />
        新しくつくる
      </button>
      <div className="task-filters">
        <div className="task-search">
          <Search size={14} />
          <input
            type="search"
            aria-label="成果を検索"
            placeholder="成果を検索"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query && (
            <button aria-label="検索を消す" onClick={() => setQuery("")}>
              <X size={13} />
            </button>
          )}
        </div>
        <select
          aria-label="成果の状態で絞り込み"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        >
          <option value="all">すべて · {tasks.length}</option>
          <option value="working">制作中 · {running}</option>
          <option value="completed">
            成果あり ·{" "}
            {tasks.filter((item) => item.state === "completed").length}
          </option>
          <option value="paused">
            停止・要対応 ·{" "}
            {tasks.filter((item) => groups.paused.includes(item.state)).length}
          </option>
        </select>
      </div>
      <div className="task-list">
        {visible.map((item) => (
          <button
            key={item.id}
            className={`task-item ${selectedId === item.id ? "selected" : ""}`}
            aria-current={selectedId === item.id ? "true" : undefined}
            title={item.title}
            onClick={() => onSelect(item.id)}
          >
            <span className={`task-state-dot ${item.state}`} />
            <strong>{item.title}</strong>
            <span>{stateLabel[item.state] ?? item.state}</span>
            <small>
              仕様 {item.specRevision} · 実行 {item.runRevision || "—"}
            </small>
          </button>
        ))}
        {!visible.length && (
          <div className="task-search-empty">
            <p>
              {tasks.length
                ? "該当する成果はありません。"
                : "最初の成果をつくると、ここに並びます。"}
            </p>
            {(query || filter !== "all") && (
              <button
                className="button-secondary"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                すべて表示
              </button>
            )}
          </div>
        )}
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
  );
}
