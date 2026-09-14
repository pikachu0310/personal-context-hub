import {
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { Form } from "@ido/common-ui";
import type { ProjectWorkspace } from "@ido/common/contracts/api";
import { api } from "./api.js";
export function ProjectView({
  projectId,
  taskId,
  deviceId,
}: {
  projectId: string;
  taskId?: string;
  deviceId?: string;
}) {
  const [state, setState] = useState<ProjectWorkspace>(),
    [error, setError] = useState("");
  const pending = useRef<{ text: string; requestId: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await api<ProjectWorkspace>("project/snapshot", {
          projectId,
        });
        if (active) {
          setState(result);
          setError("");
        }
      } catch (e) {
        if (active) {
          setState(undefined);
          setError((e as Error).message);
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId]);
  if (error) return <Alert color="red">{error}</Alert>;
  if (!state) return <Text p="xl">読み込み中…</Text>;
  const owner = state.project.ownerDeviceId === deviceId;
  const task = state.tasks.find((t) => t.id === taskId);
  return (
    <div className="project-document">
      <Stack>
        <Group justify="space-between">
          <Title order={2}>{task ? (task.title ?? task.text) : "議事録"}</Title>
          <Text c="dimmed">{state.project.name}</Text>
        </Group>
        {task ? (
          <Paper p="lg" withBorder>
            <Badge>{task.state}</Badge>
            <Text mt="md" style={{ whiteSpace: "pre-wrap" }}>
              {task.text}
            </Text>
            {task.result && (
              <Text mt="md" style={{ whiteSpace: "pre-wrap" }}>
                {task.result}
              </Text>
            )}
            <Text mt="md" size="sm">
              実行:{" "}
              {state.participants.find((p) => p.id === task.clientId)?.name ??
                "割り当て待ち"}
            </Text>
          </Paper>
        ) : (
          <>
            {!state.minutes.length && (
              <Text c="dimmed">会話が始まると議事録が表示されます。</Text>
            )}
            {state.minutes.map((m) => (
              <Paper key={m.id} p="lg" withBorder>
                <Text fw={600} mb="sm">
                  {m.name}
                </Text>
                <Text style={{ whiteSpace: "pre-wrap" }}>
                  {m.summary || "会話を待っています。"}
                </Text>
              </Paper>
            ))}
            <details>
              <summary>詳細を見る</summary>
              <Stack mt="md">
                <Title order={3}>参加しているユーザー</Title>
                {state.participants.map((p) => (
                  <Paper key={p.id} p="md" withBorder>
                    <Group justify="space-between">
                      <Text fw={600}>
                        {p.name}
                        {p.id === state.project.ownerDeviceId
                          ? " · オーナー"
                          : ""}
                      </Text>
                      <Badge color={p.codexConnected ? "teal" : "gray"}>
                        {p.codexConnected ? "Codex連携済み" : "Codex未連携"}
                      </Badge>
                    </Group>
                    <Text mt="sm" style={{ whiteSpace: "pre-wrap" }}>
                      {p.context || "個人コンテキストは未設定です。"}
                    </Text>
                    {owner && p.id !== deviceId && (
                      <Button
                        mt="sm"
                        color="red"
                        variant="subtle"
                        onClick={async () => {
                          try {
                            await api("project/remove-member", {
                              projectId,
                              deviceId: p.id,
                            });
                            setState(
                              await api("project/snapshot", { projectId }),
                            );
                          } catch (e) {
                            setError((e as Error).message);
                          }
                        }}
                      >
                        プロジェクトから削除
                      </Button>
                    )}
                  </Paper>
                ))}
                <Title order={3}>生の会話データ</Title>
                {state.minutes.map((m) => (
                  <Paper key={m.id} p="md" withBorder>
                    <Text fw={600}>{m.name}</Text>
                    {m.messages.map((message) => (
                      <Text
                        key={message.id}
                        mt="sm"
                        style={{ whiteSpace: "pre-wrap" }}
                      >
                        {new Date(message.at).toLocaleString()} ·{" "}
                        {message.authorName ?? message.authorId}
                        {"\n"}
                        {message.text}
                        {message.replyText && `\nIDO: ${message.replyText}`}
                      </Text>
                    ))}
                  </Paper>
                ))}
              </Stack>
            </details>
            <Paper p="lg" withBorder>
              <Title order={3} mb="md">
                タスクを追加
              </Title>
              <Form
                fields={[{ key: "text", label: "依頼内容", multiline: true }]}
                submit={async (data) => {
                  const text = String(data.text ?? "");
                  if (!pending.current || pending.current.text !== text)
                    pending.current = { text, requestId: crypto.randomUUID() };
                  await api("project/task", { projectId, ...pending.current });
                  pending.current = undefined;
                }}
                label="タスクを追加"
              />
            </Paper>
          </>
        )}
      </Stack>
    </div>
  );
}
