import type { MeetingView } from "@ido/common/contracts/api";

/** Conversation containers and transcripts are not necessarily minutes documents. */
export function visibleMinutes(meetings: MeetingView[]) {
  return meetings
    .filter((meeting) => meeting.summary.trim().length > 0)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
}
