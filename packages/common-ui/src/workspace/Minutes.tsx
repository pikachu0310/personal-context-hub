import { Stack, Text } from "@mantine/core";
import { Card } from "../components/Card.js";
import type { WorkspaceProps } from "../types.js";
export function Minutes({ state, page, projectId }: WorkspaceProps) {
  if (page !== "minutes") return null;
  const current = state.conversations?.find(
    (c) => c.projectId === projectId,
  )?.meetingId;
  const meetings = state.meetings
    .filter((m) => m.projectId === projectId && m.id !== current)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  return (
    <Stack>
      {!meetings.length && (
        <Text c="dimmed">
          会話が分割されると、過去の議事録がここに表示されます。
        </Text>
      )}
      {meetings.map((m) => (
        <Card key={m.id} title={m.name}>
          <Text className="minutes">{m.summary || "議事録はありません。"}</Text>
          <details>
            <summary>発言を読む</summary>
            {m.messages.map((message) => (
              <Text key={message.id}>
                {message.authorName ?? message.authorId}: {message.text}
                {message.replyText && `\nIDO: ${message.replyText}`}
              </Text>
            ))}
          </details>
        </Card>
      ))}
    </Stack>
  );
}
