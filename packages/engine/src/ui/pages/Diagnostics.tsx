import { Badge, Code, Group, Paper, Stack, Text } from "@mantine/core";
import { Card } from "../../../../ui/src/components/Card.js";
import type { Action, AdminState, Invoke } from "../../../../ui/src/types.js";
export function Diagnostics({
  state,
  action,
  invoke,
  page,
}: {
  state: AdminState;
  action: Action;
  invoke: Invoke;
  page: string;
}) {
  const admin = state.user.role === "admin";
  return (
    <>
      {page === "diagnostics" && admin && (
        <Card
          title="エラーログ"
          description="最新100件を表示します。再起動後も最大500件を保持します。入力元に表示されたエラーIDで照合できます。"
        >
          <Stack>
            {!(state.diagnostics ?? []).length && (
              <Text c="dimmed">
                記録されたエラーはありません。ログ機能の追加前に起きた失敗の詳細は復元できません。
              </Text>
            )}
            {(state.diagnostics ?? []).map((entry) => (
              <Paper p="md" withBorder key={entry.id}>
                <Stack gap="xs">
                  <Group justify="space-between">
                    <Text size="sm">{new Date(entry.at).toLocaleString()}</Text>
                    <Badge color={entry.level === "warning" ? "yellow" : "red"}>
                      {entry.level === "warning" ? "一部失敗" : "エラー"}
                    </Badge>
                  </Group>
                  <Text fw={600}>
                    {(
                      {
                        "audio.transcribe": "文字起こし",
                        "minutes.generate": "議事録生成",
                        "answer.generate": "回答生成",
                        "audio.speak": "読み上げ",
                        "task.create": "タスク作成",
                        "input.process": "入力処理",
                        "input.dispatch": "プラグイン入力",
                      } as Record<string, string>
                    )[entry.operation] ?? entry.operation}{" "}
                    · {entry.source}
                  </Text>
                  <Text>{entry.error.reason}</Text>
                  <Code block>
                    {[
                      `エラーID: ${entry.id}`,
                      `種類: ${entry.error.type}`,
                      entry.error.code && `コード: ${entry.error.code}`,
                      entry.error.status && `HTTP: ${entry.error.status}`,
                      entry.error.cause && `通信原因: ${entry.error.cause}`,
                      entry.error.parameter &&
                        `対象パラメータ: ${entry.error.parameter}`,
                      entry.model && `モデル: ${entry.model}`,
                      entry.error.requestId &&
                        `OpenAI Request ID: ${entry.error.requestId}`,
                      entry.eventId && `入力ID: ${entry.eventId}`,
                      entry.meetingId && `会議ID: ${entry.meetingId}`,
                      entry.messageId && `発言ID: ${entry.messageId}`,
                    ]
                      .filter(Boolean)
                      .join("\n")}
                  </Code>
                </Stack>
              </Paper>
            ))}
          </Stack>
        </Card>
      )}
    </>
  );
}
