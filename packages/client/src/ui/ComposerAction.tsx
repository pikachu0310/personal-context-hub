import { Icon } from "./Icons.js";
import { composerAction } from "./composer-action.js";
export function ComposerAction({
  running,
  text,
  busy,
  canSend,
  sendLabel = "送信",
  stop,
}: {
  running: boolean;
  text: string;
  busy: boolean;
  canSend: boolean;
  sendLabel?: string;
  stop?: () => void;
}) {
  const stopping = composerAction(running, text) === "stop";
  return (
    <button
      type={stopping ? "button" : "submit"}
      className={stopping ? "stop-button" : "send-button"}
      aria-label={stopping ? "タスクを停止" : sendLabel}
      title={stopping ? "タスクを停止" : sendLabel}
      disabled={busy || (stopping ? !stop : !canSend || !text.trim())}
      onClick={stopping ? stop : undefined}
    >
      <Icon name={stopping ? "stop" : "arrow"} size={stopping ? 14 : 18} />
    </button>
  );
}
