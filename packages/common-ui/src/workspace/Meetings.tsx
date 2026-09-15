import { useRef } from "react";
import { Paper, ScrollArea, Stack, Text } from "@mantine/core";
import { Card } from "../components/Card.js";
import { Form } from "../components/Form.js";
import { Status } from "../components/Status.js";
import type { WorkspaceProps } from "../types.js";
export function Meetings({
  state,
  action,
  readonly,
  page,
  projectId,
}: WorkspaceProps) {
  const pending = useRef<
    { text: string; projectId?: string; requestId: string } | undefined
  >(undefined);
  if (page !== "meetings") return null;
  const messages = state.meetings
    .filter((m) => m.projectId === projectId)
    .flatMap((m) => m.messages)
    .sort((a, b) => a.at - b.at)
    .slice(-100);
  return (
    <Stack>
      <Card
        title="現在のプロジェクトの会話"
        description="全ての入力元の会話を共有します。会話が途切れると議事録を自動で分けます。"
      >
        <Text size="sm" fw={600} mb="sm">
          プロジェクト:{" "}
          {state.projects.find((project) => project.id === projectId)?.name ??
            "未選択"}
        </Text>
        {state.conversationBindings?.map((binding) => (
          <Text key={binding.pluginId} size="sm" mb="sm">
            {binding.title} の参加先: {binding.projectName}
          </Text>
        ))}
        <ScrollArea h={messages.length ? 400 : 0}>
          {messages.map((m) => (
            <Paper key={m.id} p="sm" mb="xs" bg="gray.0">
              <Text size="xs" fw={600}>
                {m.authorName ?? (m.role === "assistant" ? "IDO" : m.authorId)}
              </Text>
              <Text style={{ whiteSpace: "pre-wrap" }}>{m.text}</Text>
              <Status value={m.stage} />
              {m.replyText && (
                <Text mt="xs" c="blue">
                  IDO: {m.replyText}
                </Text>
              )}
            </Paper>
          ))}
        </ScrollArea>
        {!messages.length && (
          <Text c="dimmed">ここから会話を始められます。</Text>
        )}
        {!readonly && projectId && (
          <Form
            key={projectId}
            fields={[{ key: "text", label: "会話に追加", multiline: true }]}
            submit={async (data) => {
              const text = String(data.text ?? "");
              if (
                !pending.current ||
                pending.current.text !== text ||
                pending.current.projectId !== projectId
              )
                pending.current = {
                  text,
                  projectId,
                  requestId: crypto.randomUUID(),
                };
              await action("messages", pending.current);
              pending.current = undefined;
            }}
            label="会話を送信"
          />
        )}
      </Card>
    </Stack>
  );
}
