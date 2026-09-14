/** Markdown task links are handled inside the Client, never by the OS. */
export type TaskReference = { projectId: string; taskId: string };
const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
export const MAX_MINUTES_LENGTH = 100_000;
export function taskUrl({ projectId, taskId }: TaskReference): string {
  if (!identifier.test(projectId) || !identifier.test(taskId))
    throw new Error("INVALID_TASK_REFERENCE");
  return `ido://projects/${projectId}/tasks/${taskId}`;
}
export function parseTaskUrl(value: string): TaskReference | undefined {
  const match =
    /^ido:\/\/projects\/([a-zA-Z0-9_-]{1,100})\/tasks\/([a-zA-Z0-9_-]{1,100})$/.exec(
      value,
    );
  return match ? { projectId: match[1], taskId: match[2] } : undefined;
}
export function taskMarkdown(reference: TaskReference, label: string): string {
  const escaped = label
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_[\]<>]/g, "\\$&");
  return `[${escaped || "タスク"}](${taskUrl(reference)})`;
}
export interface MinutesMetadata {
  summaryRevision?: number;
  summaryUpdatedAt?: number;
  summaryState?: "updating" | "failed" | "ready";
}
export interface MinutesUpdateInput {
  projectId: string;
  meetingId: string;
  markdown: string;
  expectedRevision: number;
}
