import { executionSlots } from "@ido/common/contracts/work";
import type { ClientState } from "@ido/common/contracts/api";
import { isUnrestrictedAccess } from "@ido/common/contracts/work";
export function taskReadiness(
  state: ClientState,
  task: { projectId: string; network?: boolean; agent?: "codex" | "claude" },
) {
  const mapping = state.settings.mappings.find(
    (m) => m.projectId === task.projectId,
  );
  if (!state.connected)
    return {
      reason: "connection",
      text: "このClientはEngineに接続していません。接続が復旧すると割り当てを受け取れます。",
    };
  if (!mapping)
    return {
      reason: "directory",
      text: "このClientで、このプロジェクトの保存先が未設定です。",
    };
  const agent =
    task.agent ??
    (state.loginStatus !== "authenticated" &&
    state.claudeLoginStatus === "authenticated"
      ? "claude"
      : "codex");
  if (agent === "claude" && state.claudeLoginStatus !== "authenticated")
    return {
      reason: "claude",
      text: "このClientはClaude未連携です。ユーザー設定でClaudeにログインしてください。",
    };
  if (agent === "codex" && state.loginStatus !== "authenticated")
    return {
      reason: "codex",
      text: "このClientはCodex未連携のため、タスクを受け取れません。ユーザー設定でCodexにログインしてください。",
    };
  if (!(state.allowedProjectIds?.includes(task.projectId) ?? state.allow))
    return {
      reason: "permission",
      text: "このClientでは、このプロジェクトの実行許可がOFFです。保存先を設定しただけではタスクは始まりません。「接続・設定」で実行を許可してください。",
    };
  if (agent === "claude" && mapping.accessMode === "sandbox")
    return {
      reason: "permission",
      text: "Claudeはこのサンドボックスに対応していません。接続・設定で承認を求めるかフルアクセスを選んでください。",
    };
  if (
    task.network &&
    !mapping.network &&
    !isUnrestrictedAccess(mapping.accessMode)
  )
    return {
      reason: "network",
      text: "このタスクには通信が必要ですが、このClientではプロジェクトの通信許可がOFFです。",
    };
  const occupied = state.runs.filter((r) =>
    ["assigned", "running", "interrupted"].includes(r.state),
  );
  if (
    occupied.length >= executionSlots(state.settings.slots, 1) ||
    occupied.filter((r) => r.task.projectId === task.projectId).length >=
      (mapping.workspaceMode === "project"
        ? 1
        : executionSlots(mapping.slots, 1))
  )
    return {
      reason: "capacity",
      text: "このClientの実行枠が埋まっています。実行中のタスクの完了、または中断タスクの解決を待っています。",
    };
  return {
    reason: "ready",
    text: "このClientの実行条件は揃っています。Engineからの割り当てを待っています。",
  };
}
