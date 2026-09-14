import type { DashboardState, DashboardTask } from "@ido/common/contracts/api";
export const labels: Record<string, string> = {
  running: "実行中",
  queued: "未割当",
  assigned: "割当済み",
  interrupted: "中断・要確認",
  completed: "完了",
  failed: "失敗",
  cancelled: "停止確認済み",
};
export const isActive = (t: DashboardTask) =>
  ["queued", "assigned", "running", "interrupted"].includes(t.state);
export const stopping = (t: DashboardTask) =>
  t.stop && !["stopped", "rejected"].includes(t.stop.delivery);
export const status = (t: DashboardTask) =>
  stopping(t) ? "停止要求中" : labels[t.state] || t.state;
export const color = (t: DashboardTask) =>
  stopping(t)
    ? "orange"
    : t.state === "running"
      ? "green"
      : ["queued", "assigned"].includes(t.state)
        ? "yellow"
        : ["failed", "interrupted"].includes(t.state)
          ? "red"
          : "gray";
export const attention = (t: DashboardTask) =>
  !!t.waitReason || t.state === "failed" || !!stopping(t);
export const time = (at?: number) =>
  at
    ? new Date(at).toLocaleTimeString("ja-JP", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "未取得";
export const dateTime = (at?: number) =>
  at ? new Date(at).toLocaleString("ja-JP") : "未取得";
export const elapsed = (t: DashboardTask, now: number) => {
  const seconds = Math.max(
    0,
    Math.floor(
      ((isActive(t) ? now : t.updatedAt) - (t.assignedAt ?? t.createdAt)) /
        1000,
    ),
  );
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
};
export const projectName = (s: DashboardState, id?: string) =>
  s.projects.find((p) => p.id === id)?.name ?? id ?? "未取得";
export const userName = (s: DashboardState, id?: string) =>
  s.users.find((u) => u.id === id)?.name ?? id ?? "—";
export type Selection = { kind: "task" | "user" | "project"; id: string };
