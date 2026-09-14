import { MeetingNotes } from "./MeetingNotes.js";
import { Stack, Text } from "@mantine/core";
import { Card } from "../components/Card.js";
import type { WorkspaceProps } from "../types.js";
export function Minutes({ state, page, projectId }: WorkspaceProps) {
  if (page !== "minutes") return null;
  const meetings = state.meetings
    .filter((m) => m.projectId === projectId)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return (
    <Stack>
      {!meetings.length && (
        <Text c="dimmed">会話が始まると、議事録がここに表示されます。</Text>
      )}
      {meetings.map((m) => (
        <Card key={m.id} title={m.name}>
          <Text className="minutes">{m.summary || "議事録はありません。"}</Text>
        </Card>
      ))}
      <MeetingNotes key={projectId} meetings={meetings} />
    </Stack>
  );
}
