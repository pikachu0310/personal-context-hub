import { MeetingNotes } from "./MeetingNotes.js";
import type { WorkspaceProps } from "../types.js";
export function Minutes({ state, page, projectId }: WorkspaceProps) {
  if (page !== "minutes") return null;
  const meetings = state.meetings
    .filter((m) => m.projectId === projectId)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return <MeetingNotes key={projectId} meetings={meetings} />;
}
