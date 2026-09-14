import type { ClientState } from "@ido/common/contracts/api";
export function taskReadiness(
  state: ClientState,
  task: { projectId: string; network?: boolean },
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
  if (state.loginStatus !== "authenticated")
    return {
      reason: "codex",
      text: "このClientはCodex未連携のため、タスクを受け取れません。ユーザー設定でCodexにログインしてください。",
    };
  if (!(state.allowedProjectIds?.includes(task.projectId) ?? state.allow))
    return {
      reason: "permission",
      text: "このClientでは、このプロジェクトの実行許可がOFFです。保存先を設定しただけではタスクは始まりません。「接続・設定」で実行を許可してください。",
    };
  if (task.network && !mapping.network)
    return {
      reason: "network",
      text: "このタスクには通信が必要ですが、このClientではプロジェクトの通信許可がOFFです。",
    };
  const occupied = state.runs.filter((r) =>
    ["assigned", "running", "interrupted"].includes(r.state),
  );
  if (
    occupied.length >= state.settings.slots ||
    occupied.filter((r) => r.task.projectId === task.projectId).length >=
      mapping.slots
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
