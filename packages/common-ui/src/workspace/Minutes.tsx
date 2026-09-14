import { Button, Stack, Text } from "@mantine/core";
import { Card } from "../components/Card.js";
import type { WorkspaceProps } from "../types.js";
export function Minutes({ state, page, setPage }: WorkspaceProps) {
  if (page !== "minutes") return null;
  return (
    <Stack>
      {!state.meetings.length && (
        <Text c="dimmed">会議を作成すると、議事録がここに表示されます。</Text>
      )}
      {state.meetings.map((meeting) => (
        <Card key={meeting.id} title={meeting.name}>
          <Text className="minutes">
            {meeting.summary || "まだ議事録はありません。"}
          </Text>
          <Button variant="subtle" onClick={() => setPage("meetings")}>
            会話を開く
          </Button>
        </Card>
      ))}
    </Stack>
  );
}
