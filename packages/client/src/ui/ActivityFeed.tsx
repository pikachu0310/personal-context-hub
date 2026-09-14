import type { ClientActivity } from "@ido/common/contracts/api";
import { Icon } from "./Icons.js";

export const stateLabel = (state: string) =>
  ({
    running: "実行中",
    in_progress: "実行中",
    assigned: "開始待ち",
    queued: "待機中",
    completed: "完了",
    failed: "失敗",
    cancelled: "停止済み",
    interrupted: "中断",
    pending: "待機中",
    accepted: "反映済み",
    uncertain: "配送確認が必要",
    declined: "拒否",
  })[state] ?? state;
export const activeState = (state: string) =>
  ["running", "assigned", "queued"].includes(state);
function Inline({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(\*\*[^*]+\*\*|`[^`]+`)/g)
        .map((part, i) =>
          part.startsWith("**") ? (
            <strong key={i}>{part.slice(2, -2)}</strong>
          ) : part.startsWith("`") ? (
            <code key={i}>{part.slice(1, -1)}</code>
          ) : (
            part
          ),
        )}
    </>
  );
}
// Text-only Markdown subset. No HTML, images, remote resources or automatic links.
export function MessageText({ text }: { text: string }) {
  return (
    <div className="message-text">
      {text.split(/(```[\s\S]*?```)/g).map((block, i) =>
        block.startsWith("```") ? (
          <pre key={i}>{block.slice(3, -3).replace(/^[\w+-]*\n/, "")}</pre>
        ) : (
          <div key={i}>
            {block.split("\n").map((line, n) =>
              /^[-*] /.test(line) ? (
                <div className="message-bullet" key={n}>
                  • <Inline text={line.slice(2)} />
                </div>
              ) : (
                <div
                  className={
                    /^#{1,3} /.test(line) ? "message-heading" : undefined
                  }
                  key={n}
                >
                  <Inline text={line.replace(/^#{1,3} /, "")} />
                  {!line && <br />}
                </div>
              ),
            )}
          </div>
        ),
      )}
    </div>
  );
}
export function ActivityItem({ entry }: { entry: ClientActivity }) {
  const when = new Date(entry.at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  if (entry.kind === "message" || entry.kind === "instruction")
    return (
      <article
        className={
          entry.kind === "instruction" ? "user-message" : "agent-message"
        }
      >
        <div className="entry-meta">
          {entry.kind === "instruction" ? "あなた・追加指示" : "IDO Agent"}
          <time dateTime={new Date(entry.at).toISOString()}>{when}</time>
          {entry.kind === "instruction" && entry.status && (
            <span>{stateLabel(entry.status)}</span>
          )}
        </div>
        <MessageText text={entry.text ?? ""} />
        {entry.truncated && (
          <p className="muted">長い出力のため一部を省略しました。</p>
        )}
      </article>
    );
  if (entry.kind === "status")
    return (
      <div
        className={`timeline-status ${entry.status === "failed" ? "is-error" : ""}`}
      >
        <span>{entry.title}</span>
        <time>{when}</time>
        {entry.text && <small>{entry.text}</small>}
      </div>
    );
  return (
    <details className="tool-entry">
      <summary>
        <Icon
          name={
            entry.kind === "command"
              ? "terminal"
              : entry.kind === "files"
                ? "file"
                : "settings"
          }
        />
        <span className="tool-title">
          {entry.kind === "files"
            ? `${entry.files?.length ?? 0} 件のファイルを変更`
            : entry.title}
        </span>
        <span
          className={`tool-state ${entry.status === "failed" ? "is-error" : ""}`}
        >
          {entry.status && stateLabel(entry.status)}
        </span>
        <Icon name="chevron" size={14} />
      </summary>
      <div className="tool-details">
        <time>{when}</time>
        {entry.text && <pre>{entry.text}</pre>}
        {entry.output && <pre className="command-output">{entry.output}</pre>}
        {entry.exitCode !== undefined && (
          <div className={entry.exitCode === 0 ? "muted" : "is-error"}>
            終了コード {entry.exitCode}
          </div>
        )}
        {entry.files?.map((file, i) => (
          <div className="changed-file" key={i}>
            <Icon name="file" size={14} />
            <code>{file.path}</code>
            <span>{file.kind}</span>
          </div>
        ))}
        {entry.truncated && (
          <p className="muted">長い出力のため一部を省略しました。</p>
        )}
      </div>
    </details>
  );
}
