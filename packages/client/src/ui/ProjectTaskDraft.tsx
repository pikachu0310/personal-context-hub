import { useState } from "react";
import type { Task } from "@ido/common/contracts/protocol";
import { api } from "./api.js";
import { ComposerAction } from "./ComposerAction.js";
export function ProjectTaskDraft({
  projectId,
  draft,
  onChange,
  sendingText,
  connected,
  created,
}: {
  projectId: string;
  draft: { text: string; requestId: string; sentText?: string };
  onChange: (text: string) => void;
  sendingText: (text: string) => void;
  connected: boolean;
  created: (task: Task) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const text = draft.text;
  async function send() {
    if (busy || !connected || !text.trim()) return;
    setError("");
    if (draft.sentText && draft.sentText !== text.trim()) {
      setError(
        "前の送信結果が未確認です。前と同じ内容で送信して確認してください。",
      );
      return;
    }
    const sentText = draft.sentText ?? text.trim();
    sendingText(sentText);
    setBusy(true);
    try {
      const task = await api<Task>("project/task", {
        projectId,
        text: sentText,
        requestId: draft.requestId,
      });
      await created(task);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="task-workspace" aria-label="新しいタスク">
      <div className="conversation-scroll">
        <div className="empty-workspace">
          <h2>新しいタスク</h2>
          <p>依頼を書いて送信すると、このプロジェクトに追加されます。</p>
        </div>
      </div>
      <div className="composer-dock">
        {error && (
          <p className="composer-notice" role="alert">
            {error}
          </p>
        )}
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            autoFocus
            aria-label="新しいタスクへの依頼"
            placeholder="何を進めますか？"
            value={text}
            maxLength={8000}
            disabled={busy}
            onChange={(e) => onChange(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="composer-toolbar">
            <span className="composer-spacer" />
            <ComposerAction
              running={false}
              text={text}
              busy={busy}
              canSend={connected}
            />
          </div>
        </form>
        <p className="composer-footnote">
          {connected
            ? "Enterで送信 · Shift + Enterで改行"
            : "Engineに接続すると送信できます"}
        </p>
      </div>
    </section>
  );
}
