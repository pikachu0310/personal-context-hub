import { ModelControls } from "./ModelControls.js";
import type { ProjectDraft } from "./project-drafts.js";
import { useState } from "react";
import type { Task, Mapping } from "@ido/common/contracts/protocol";
import type { Action } from "@ido/common-ui";
import { ComposerDropdown } from "./ComposerDropdown.js";
import { accessOptions, accessHelp, projectAccessHelp } from "./access-mode.js";
import { api } from "./api.js";
import { ComposerAction } from "./ComposerAction.js";
import newTaskMascot from "./assets/new-task-mascot.gif";
export function ProjectTaskDraft({
  projectId,
  draft,
  onChange,
  sendingText,
  settled,
  connected,
  created,
  mapping,
  action,
}: {
  mapping?: Mapping;
  action: Action;
  projectId: string;
  draft: ProjectDraft;
  onChange: (text: string) => void;
  sendingText: (text: string) => void;
  settled: (requestId: string) => void;
  connected: boolean;
  created: (task: Task) => Promise<void>;
}) {
  const [savingAccess, setSavingAccess] = useState(false);
  const busy = !!draft.busy || savingAccess;
  const [error, setError] = useState("");
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
      settled(draft.requestId);
    }
  }
  return (
    <section className="task-workspace" aria-label="新しいタスク">
      <div className="conversation-scroll new-task-welcome">
        <div className="empty-workspace">
          <img
            className="new-task-mascot"
            src={newTaskMascot}
            alt=""
            width={336}
            height={336}
          />
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
            <ModelControls key={projectId} projectId={projectId} />
            <ComposerDropdown
              label="新しいタスクの権限"
              value={mapping?.accessMode ?? "sandbox"}
              options={accessOptions}
              disabled={busy || !mapping}
              onChange={async (accessMode) => {
                setSavingAccess(true);
                setError("");
                try {
                  await action("access-mode", { projectId, accessMode });
                } catch (error) {
                  setError((error as Error).message);
                } finally {
                  setSavingAccess(false);
                }
              }}
            />
            <ComposerAction
              running={false}
              text={text}
              busy={busy}
              canSend={connected}
            />
          </div>
        </form>
        <p className="composer-footnote">
          {projectAccessHelp} {accessHelp[mapping?.accessMode ?? "sandbox"]}
        </p>
        <p className="composer-footnote">
          {connected
            ? "Enterで送信 · Shift + Enterで改行"
            : "Engineに接続すると送信できます"}
        </p>
      </div>
    </section>
  );
}
