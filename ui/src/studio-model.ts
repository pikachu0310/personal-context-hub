export type Actor = { id: string; name: string; role: "operator" | "viewer" };
export type StudioTask = {
  id: string;
  title: string;
  request: string;
  state: string;
  createdAt: number;
  controlVersion: number;
  specRevision: number;
  runRevision: number;
  resultSpecRevision?: number;
  resultRunRevision?: number;
  result: string;
  verification: string;
  acceptanceCriteria: string[];
  sourceSequences: number[];
  instructions: { text: string; specRevision?: number }[];
  preview?: {
    state: string;
    runRevision: number;
    specRevision: number;
    browserVerified: boolean;
    verification: string;
    expiresAt: number;
    confirmations: { userId: string; at: number }[];
    url?: string;
  };
};
export type StudioSnapshot = {
  name: string;
  meetingId: string;
  revision: number;
  connected: boolean;
  minutes: string;
  actor: Actor;
  statements: {
    id: string;
    sequence: number;
    text: string;
    speaker: string;
    at: number;
  }[];
  tasks: StudioTask[];
  activity: {
    sequence: number;
    stage: string;
    status: string;
    taskId?: string;
    text?: string;
    summary?: string;
    tool?: string;
    at: number;
  }[];
};
export type Room = { id: string; name: string; description: string };
export const stateLabel: Record<string, string> = {
  queued: "受付済み",
  running: "制作中",
  completed: "成果が届きました",
  failed: "確認が必要",
  interrupted: "中断しました",
  cancelled: "停止しました",
};
export function currentPreview(task?: StudioTask) {
  return task?.preview?.state === "available" &&
    task.preview.specRevision === task.specRevision &&
    task.preview.runRevision === task.runRevision
    ? task.preview
    : undefined;
}
