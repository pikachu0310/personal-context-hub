import { useRef, useState } from "react";
import type { ClientState } from "@ido/common/contracts/api";
import type { Task } from "@ido/common/contracts/protocol";
import { ComposerAction } from "./ComposerAction.js";
import { api } from "./api.js";
export function TaskFollowup({
  task,
  state,
}: {
  task: Pick<Task, "id" | "revision" | "state">;
  state: ClientState;
}) {
  const [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const pending = useRef<
    { text: string; requestId: string; revision: number } | undefined
  >(undefined);
  const terminal = ["completed", "failed", "cancelled", "interrupted"].includes(
    task.state,
  );
  if (!terminal) return null;
  const canSend = state.connected && state.continuationSupported === true;
  async function send() {
    if (busy || !canSend || !text.trim()) return;
    if (pending.current && pending.current.text !== text.trim()) {
      setNotice(
        "前の送信結果が未確認です。同じ内容で再送して確認してください。",
      );
      return;
    }
    pending.current ??= {
      text: text.trim(),
      requestId: crypto.randomUUID(),
      revision: task.revision,
    };
    setBusy(true);
    setNotice("");
    try {
      await api("project/continue", { taskId: task.id, ...pending.current });
      setText("");
      pending.current = undefined;
      setNotice("元のタスクの続きとして受け付けました。");
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="composer-dock">
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          aria-label="エージェントへの追加指示"
          placeholder="このタスクの続きを依頼する"
          value={text}
          maxLength={8000}
          disabled={busy}
          onChange={(e) => setText(e.currentTarget.value)}
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
            canSend={canSend}
            sendLabel="追加指示を送信"
          />
        </div>
      </form>
      <p className="composer-footnote">
        {canSend
          ? "元の会話と作業フォルダーを引き継いで続行します。"
          : "続行に対応したEngineへ接続すると送信できます。"}
      </p>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
