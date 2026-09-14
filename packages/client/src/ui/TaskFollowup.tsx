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
  const stopRequest = useRef(crypto.randomUUID());
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
      await api(terminal ? "project/continue" : "project/control", {
        taskId: task.id,
        ...pending.current,
        operation: "steer",
      });
      setText("");
      pending.current = undefined;
      setNotice(
        terminal
          ? "元のタスクの続きとして受け付けました。"
          : "追加指示を受け付けました。行動ログで反映を確認できます。",
      );
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
          placeholder={
            terminal ? "このタスクの続きを依頼する" : "実行担当への追加指示"
          }
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
            running={!terminal}
            text={text}
            busy={busy}
            canSend={canSend}
            sendLabel="追加指示を送信"
            stop={() => {
              setBusy(true);
              void api("project/control", {
                taskId: task.id,
                revision: task.revision,
                operation: "stop",
                requestId: `${stopRequest.current}-${task.id}-${task.revision}`,
              })
                .then(() =>
                  setNotice(
                    "停止を要求しました。実行PCからの停止確認をお待ちください。",
                  ),
                )
                .catch((e) => setNotice((e as Error).message))
                .finally(() => setBusy(false));
            }}
          />
        </div>
      </form>
      <p className="composer-footnote">
        {canSend
          ? terminal
            ? "元の会話と作業フォルダーを引き継いで続行します。"
            : "実行PCへ指示・停止を送ります。権限の承認は実行PCで行います。"
          : "続行に対応したEngineへ接続すると送信できます。"}
      </p>
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
