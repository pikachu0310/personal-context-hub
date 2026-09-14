import { randomUUID } from "node:crypto";
import type { ClientActivity } from "@ido/common/contracts/api";
import type { Run } from "./executor.js";

const MAX_ENTRIES = 300;
const MAX_CHARS = 256_000;
const FIELD_LIMIT = 16_000;

// Local activity is deliberately bounded and never included in report().
// Mask familiar credential forms before persistence; this is not a public log.
export function activityText(value: unknown, limit = FIELD_LIMIT): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, Math.max(limit * 2, 65536))
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(
      /-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g,
      "[credential hidden]",
    )
    .replace(
      /\b(?:sk-(?:proj-|svcacct-)?[\w-]{20,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,})/g,
      "[credential hidden]",
    )
    .replace(/\b[MN][\w-]{23,}\.[\w-]{6}\.[\w-]{27,}/g, "[credential hidden]")
    .replace(/\bBearer\s+[\w.+/=-]+/gi, "Bearer [hidden]")
    .replace(
      /\b((?:[\w-]{0,80}(?:token|secret|password|api[_-]?key))["']?\s*[:=]\s*)["']?[^\s,"'}]+["']?/gi,
      "$1[hidden]",
    )
    .slice(0, limit);
}

export function recordActivity(
  run: Run,
  value: Omit<ClientActivity, "id" | "revision" | "at" | "updatedAt"> & {
    id?: string;
  },
) {
  run.activity ??= [];
  const key = `${run.task.revision}:${value.id ?? randomUUID()}`;
  const previous = run.activity.find((entry) => entry.id === key);
  const now = Date.now();
  const entry: ClientActivity = {
    id: key,
    revision: run.task.revision,
    at: previous?.at ?? now,
    updatedAt: now,
    kind: value.kind,
    sender: previous?.sender ?? value.sender,
    sentAt: previous?.sentAt ?? value.sentAt,
    event: value.event,
    requestAt: value.requestAt,
    title: activityText(value.title, 300),
    status: value.status,
    text: value.text === undefined ? undefined : activityText(value.text),
    output: value.output === undefined ? undefined : activityText(value.output),
    exitCode: value.exitCode,
    files: value.files?.slice(0, 100).map((file) => ({
      path: activityText(file.path, 1000),
      kind: activityText(file.kind, 30),
    })),
    truncated:
      value.truncated ||
      (value.text?.length ?? 0) > FIELD_LIMIT ||
      (value.output?.length ?? 0) > FIELD_LIMIT ||
      (value.files?.length ?? 0) > 100,
  };
  if (previous) Object.assign(previous, entry);
  else run.activity.push(entry);
  let size = JSON.stringify(run.activity).length;
  while (run.activity.length > MAX_ENTRIES || size > MAX_CHARS) {
    const removed = run.activity.shift()!;
    size -= JSON.stringify(removed).length + 1;
    run.activityDropped = (run.activityDropped ?? 0) + 1;
  }
  run.activityVersion = (run.activityVersion ?? 0) + 1;
  run.updatedAt = now;
}

export function recordEvent(run: Run, event: any): boolean {
  const item = event.item;
  if (
    !item ||
    !["item.started", "item.updated", "item.completed"].includes(event.type)
  )
    return false;
  const status =
    event.type === "item.completed"
      ? (item.status ?? "completed")
      : (item.status ?? "running");
  const base = { id: item.id, status };
  if (item.type === "agent_message") {
    if (!item.text) return false;
    recordActivity(run, {
      ...base,
      kind: "message",
      title:
        item.phase === "commentary"
          ? "作業メモ"
          : item.phase === "plan"
            ? "計画"
            : "結果",
      text: item.text,
    });
  } else if (item.type === "command_execution") {
    recordActivity(run, {
      ...base,
      kind: "command",
      title: "コマンドを実行",
      text: item.command,
      output: item.aggregated_output,
      exitCode: item.exit_code,
    });
  } else if (item.type === "file_change") {
    recordActivity(run, {
      ...base,
      kind: "files",
      title: "ファイルを変更",
      files: item.changes,
    });
  } else if (item.type === "web_search") {
    recordActivity(run, {
      ...base,
      kind: "tool",
      title: "Webを検索",
      text: item.query,
    });
  } else if (item.type === "mcp_tool_call") {
    // Tool arguments/results may carry credentials or private source bodies.
    recordActivity(run, {
      ...base,
      kind: "tool",
      title: "ツールを使用",
      text: `${item.server ?? "MCP"} / ${item.tool ?? "tool"}`,
    });
  } else return false;
  return true;
}

export function executionError(error: unknown) {
  const message = (error as Error)?.message;
  if (message === "MEETING_MODEL_UNAVAILABLE")
    return "会議タスク用のSol・Sparkをこのアカウントで利用できません。接続したCodexアカウントのモデル一覧を確認してください。";
  if (message === "CLAUDE_AUTH_OR_API_FAILED")
    return "Claudeの認証またはAPI呼び出しに失敗しました。Claudeの公式ログインと利用可能な枠を確認してください。";
  if (message === "CLAUDE_TURN_FAILED" || message === "CLAUDE_TASK_INCOMPLETE")
    return "Claudeが正常な完了結果を返しませんでした。操作の承認状況とClaudeの認証状態を確認してください。";
  const code = (error as { code?: string })?.code;
  if (code === "AGENT_SANDBOX_NOT_READY")
    return "書き込み用サンドボックスを利用できません。接続設定と実行環境を確認してください。";
  if (code === "ENOENT")
    return "必要な実行ファイルまたはフォルダーが見つかりません。Git・エージェントの実行環境と作業フォルダーを確認してください。";
  if (code === "CODEX_RPC_TIMEOUT")
    return "Codexからの応答が時間内に届きませんでした。重複実行を避けるため自動再実行していません。";
  return "実行が完了しませんでした。直前のコマンド・出力と、使用中のエージェントのログイン状態を確認してください。";
}
