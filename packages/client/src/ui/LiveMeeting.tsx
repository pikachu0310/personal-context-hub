import {
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Select,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useState } from "react";
import type {
  ClientState,
  ProjectWorkspace,
  TaskReference,
} from "@ido/common/contracts/api";
import { stateLabel } from "./ActivityFeed.js";
import { taskReadiness } from "./task-readiness.js";
import "./live-meeting.css";

const time = (at: number) =>
  new Date(at).toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
export function LiveMeeting({
  workspace,
  client,
  openTask,
  openSettings,
}: {
  workspace: ProjectWorkspace;
  client: ClientState;
  openTask: (reference: TaskReference) => void;
  openSettings: () => void;
}) {
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const meetings = [...workspace.minutes].sort(
    (a, b) =>
      (b.lastMessageAt ?? b.startedAt ?? 0) -
      (a.lastMessageAt ?? a.startedAt ?? 0),
  );
  const meeting = meetings.find((m) => m.id === meetingId) ?? meetings[0];
  const messages = [...(meeting?.messages ?? [])]
    .sort((a, b) => b.at - a.at)
    .slice(0, 20);
  const tasks = workspace.tasks
    .filter(
      (task) =>
        !meeting ||
        task.meetingId === meeting.id ||
        task.sourceIds?.some((id) =>
          messages.some((message) => message.id === id),
        ),
    )
    .sort(
      (a, b) =>
        Number(["running", "assigned", "queued"].includes(b.state)) -
          Number(["running", "assigned", "queued"].includes(a.state)) ||
        b.updatedAt - a.updatedAt,
    )
    .slice(0, 8);
  const mapping = client.settings.mappings.find(
    (m) => m.projectId === workspace.project.id,
  );
  const ready = taskReadiness(client, { projectId: workspace.project.id });
  const speakers = new Map(
    messages
      .filter((message) => message.role !== "assistant")
      .map((message) => [
        message.authorIdentityId ?? message.authorId,
        message.authorName ?? "参加者",
      ]),
  );
  return (
    <Stack gap="md" className="live-meeting">
      <Paper withBorder p="md">
        <Group justify="space-between" align="flex-start">
          <Stack gap={4} style={{ minWidth: 0, flex: 1 }}>
            <Group gap="xs">
              <Badge color={client.connected ? "teal" : "orange"}>
                {client.connected ? "Engine接続中" : "Engine未接続"}
              </Badge>
              <Badge
                variant="outline"
                color={ready.reason === "ready" ? "teal" : "gray"}
              >
                {ready.reason === "ready"
                  ? "タスク受付可能"
                  : ready.reason === "capacity"
                    ? "作業中"
                    : "実行設定を確認"}
              </Badge>
            </Group>
            <Text size="sm">{ready.text}</Text>
            <Text size="xs" c="dimmed" className="live-meeting-directory">
              作業先: {mapping?.directory || "未設定"} ·{" "}
              {mapping?.workspaceMode === "project"
                ? "保存先を直接編集"
                : "タスクごとの別フォルダー"}
            </Text>
          </Stack>
          <Button size="xs" variant="subtle" onClick={openSettings}>
            作業設定
          </Button>
        </Group>
      </Paper>
      <Group align="flex-end" justify="space-between">
        <Select
          label="表示する会話"
          aria-label="表示する会話"
          value={meeting?.id ?? null}
          onChange={setMeetingId}
          data={meetings.map((m) => ({
            value: m.id,
            label: `${m.name} · ${new Date(m.lastMessageAt ?? m.startedAt ?? 0).toLocaleString("ja-JP")}`,
          }))}
          placeholder="まだ会話がありません"
          style={{ flex: 1, maxWidth: 520 }}
        />
        <Text size="xs" c="dimmed">
          最新の発言が上に表示されます · 約2.5秒ごとに更新
        </Text>
      </Group>
      <div className="live-meeting-grid">
        <section aria-label="ライブの発言">
          <Group justify="space-between" mb="sm">
            <Title order={3}>会話</Title>
            <Text size="sm" c="dimmed">
              直近の話者 {speakers.size}人
            </Text>
          </Group>
          <Group gap={6} mb="sm">
            {[...speakers].map(([id, name]) => (
              <Badge key={id} variant="light" color="gray">
                {name}
              </Badge>
            ))}
          </Group>
          {!messages.length && (
            <Alert color="gray">
              Discordで話すか「会議へ発言する」から入力すると、ここに話者と発言が表示されます。
            </Alert>
          )}
          <Stack gap="sm">
            {messages.map((message) => {
              const related = workspace.tasks.filter(
                (task) =>
                  task.sourceIds?.includes(message.id) ||
                  task.sourceStatements?.some(
                    (source) => source.id === message.id,
                  ),
              );
              return (
                <Paper withBorder p="md" key={message.id}>
                  <Group justify="space-between" mb={6}>
                    <Text size="sm" fw={600}>
                      {message.role === "assistant"
                        ? "IDO"
                        : (message.authorName ?? "参加者")}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {time(message.at)}
                    </Text>
                  </Group>
                  <Text
                    size="sm"
                    style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                  >
                    {message.text.trim() ||
                      (message.steps?.transcription?.state === "failed"
                        ? "文字起こしに失敗しました。"
                        : ["pending", "running"].includes(
                              message.steps?.transcription?.state ?? "",
                            )
                          ? "音声を受信しました。文字起こし中…"
                          : "この音声では発言が検出されませんでした。")}
                  </Text>
                  {message.replyText && (
                    <Text
                      size="sm"
                      mt="sm"
                      c="dimmed"
                      style={{ whiteSpace: "pre-wrap" }}
                    >
                      IDO: {message.replyText}
                    </Text>
                  )}
                  {Object.values(message.steps ?? {}).some(
                    (step) => step.state === "failed",
                  ) && (
                    <Text size="xs" c="red" mt="xs">
                      {Object.entries(message.steps ?? {})
                        .filter(([, step]) => step.state === "failed")
                        .map(
                          ([name]) =>
                            ({
                              transcription: "文字起こし",
                              reply: "応答",
                              minutes: "議事録",
                              delivery: "返答の配送",
                            })[name] ?? "発言の処理",
                        )
                        .join("・")}
                      でエラーが発生しています。
                    </Text>
                  )}
                  {related.length > 0 && (
                    <Group gap="xs" mt="sm">
                      {related.map((task) => (
                        <Button
                          key={task.id}
                          size="compact-xs"
                          variant="light"
                          onClick={() =>
                            openTask({
                              projectId: task.projectId,
                              taskId: task.id,
                            })
                          }
                        >
                          作業を開く: {task.title ?? "タスク"}
                        </Button>
                      ))}
                    </Group>
                  )}
                </Paper>
              );
            })}
          </Stack>
        </section>
        <section aria-label="会話から進んでいる作業">
          <Title order={3} mb="sm">
            進んでいる作業
          </Title>
          <Text size="sm" c="dimmed" mb="sm">
            作業を開いて追加指示を送ると、同じタスクで修正を続けられます。
          </Text>
          {!tasks.length && (
            <Alert color="gray">
              この会話から始まったタスクはまだありません。
            </Alert>
          )}
          <Stack gap="sm">
            {tasks.map((task) => (
              <Paper withBorder p="md" key={task.id}>
                <Group justify="space-between" mb="xs">
                  <Badge
                    variant="light"
                    color={
                      task.state === "running"
                        ? "teal"
                        : task.state === "failed"
                          ? "red"
                          : "gray"
                    }
                  >
                    {stateLabel(task.state)}
                  </Badge>
                  <Text size="xs" c="dimmed">
                    {time(task.updatedAt)}
                  </Text>
                </Group>
                <Text fw={600} size="sm">
                  {task.title ?? task.text.slice(0, 100)}
                </Text>
                {task.progress && (
                  <Text size="sm" c="dimmed" mt="xs" lineClamp={3}>
                    {task.progress}
                  </Text>
                )}
                {task.resultSpecRevision !== undefined &&
                  task.resultSpecRevision !== (task.specRevision ?? 1) && (
                    <Text size="xs" c="orange" mt="xs">
                      追加指示の反映を確認してください。
                    </Text>
                  )}
                <Button
                  variant="light"
                  mt="sm"
                  fullWidth
                  onClick={() =>
                    openTask({ projectId: task.projectId, taskId: task.id })
                  }
                >
                  作業・追加指示を開く
                </Button>
              </Paper>
            ))}
          </Stack>
        </section>
      </div>
    </Stack>
  );
}
