import { Code, Group, Paper, ScrollArea, Stack, Text } from "@mantine/core";
import { Card } from "../components/Card.js";
import { Form } from "../components/Form.js";
import { Status } from "../components/Status.js";
import type { WorkspaceProps } from "../types.js";
export function Meetings({
  state,
  action,
  invoke,
  showPreview,
  readonly,
  activity,
  page,
}: WorkspaceProps) {
  const admin = state.user.role === "admin";
  return (
    <>
      {page === "meetings" && (
        <Stack>
          {!readonly && !activity && (
            <Card title="新しい会議">
              <Form
                fields={[
                  { key: "name", label: "会議名" },
                  {
                    key: "projectId",
                    label: "会議のプロジェクト",
                    optional: true,
                    options: state.projects.map((p) => ({
                      value: p.id,
                      label: p.name,
                    })),
                  },
                ]}
                submit={(data) => action("meetings", data)}
                label="会議を作成"
              />
            </Card>
          )}
          {state.meetings.map((meeting) => (
            <Card
              key={meeting.id}
              title={meeting.name}
              description={`${meeting.messages.length} messages`}
            >
              <Code>{meeting.id}</Code>
              <Text className="minutes">
                {meeting.summary ||
                  "会話を受け付けると、ここに議事録がまとまります。"}
              </Text>
              <ScrollArea h={meeting.messages.length ? 180 : 0}>
                {meeting.messages.slice(-30).map((m) => (
                  <Paper key={m.id} p="sm" mb="xs" bg="gray.0">
                    <Text
                      size="xs"
                      fw={600}
                      c={m.role === "assistant" ? "blue" : "dimmed"}
                    >
                      {m.authorName ??
                        (m.role === "assistant" ? "IDO" : m.authorId)}
                    </Text>
                    <Group justify="space-between">
                      <Text size="sm">{m.text}</Text>
                      <Status value={m.stage} />
                      {Object.entries(m.steps ?? {}).map(([step, value]) => (
                        <Text size="xs" key={step}>
                          {(
                            {
                              transcription: "文字起こし",
                              reply: "即時応答",
                              minutes: "議事録",
                              delivery: "送信",
                            } as Record<string, string>
                          )[step] ?? step}
                          : {value.state}
                          {value.errorId && ` · ${value.errorId}`}
                        </Text>
                      ))}
                    </Group>
                    {m.replyText && (
                      <Text mt="xs" size="sm" c="blue">
                        IDO: {m.replyText}
                      </Text>
                    )}
                  </Paper>
                ))}
              </ScrollArea>
              {!readonly && (
                <Form
                  fields={[
                    {
                      key: "text",
                      label: "会話に追加",
                      multiline: true,
                    },
                  ]}
                  submit={(data) =>
                    action("messages", { ...data, meetingId: meeting.id })
                  }
                  label="会話を送信"
                />
              )}
            </Card>
          ))}
        </Stack>
      )}
    </>
  );
}
