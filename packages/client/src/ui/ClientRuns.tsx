import {
  Badge,
  Button,
  Code,
  Grid,
  Group,
  Paper,
  ScrollArea,
  Stack,
  Text,
  TextInput,
  UnstyledButton,
} from "@mantine/core";
import { useState } from "react";
import { Card } from "../../../ui/src/components/Card.js";
import { Form } from "../../../ui/src/components/Form.js";
import { Status } from "../../../ui/src/components/Status.js";
import type { Action, ClientState, Invoke } from "../../../ui/src/types.js";
export function ClientRuns({
  state,
  action,
  invoke,
}: {
  state: ClientState;
  action: Action;
  invoke: Invoke;
}) {
  const [selected, select] = useState<string>(),
    [query, search] = useState("");
  const active = (value: string) =>
    ["running", "assigned", "queued"].includes(value);
  const runs = [...state.runs]
    .filter((r) =>
      `${r.task.title ?? ""} ${r.task.text}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        Number(active(b.state)) - Number(active(a.state)) ||
        b.task.updatedAt - a.task.updatedAt,
    );
  const current = runs.find((r) => r.task.runId === selected) ?? runs[0];
  return (
    <Grid gap="lg">
      <Grid.Col span={{ base: 12, md: 4 }}>
        <Paper withBorder p="md">
          <Stack>
            <Group justify="space-between">
              <Text fw={600}>このPCのタスク</Text>
              <Badge>
                {state.runs.filter((r) => active(r.state)).length} 実行中
              </Badge>
            </Group>
            <TextInput
              placeholder="タスクを検索"
              aria-label="タスクを検索"
              value={query}
              onChange={(event) => search(event.currentTarget.value)}
            />
            <ScrollArea mah={600}>
              <Stack gap="xs">
                {runs.map((r) => (
                  <UnstyledButton
                    key={r.task.runId}
                    onClick={() => select(r.task.runId)}
                    aria-pressed={current?.task.runId === r.task.runId}
                  >
                    <Paper
                      p="sm"
                      bg={
                        current?.task.runId === r.task.runId
                          ? "blue.0"
                          : undefined
                      }
                      withBorder
                    >
                      <Text lineClamp={2} fw={500}>
                        {r.task.title ?? r.task.text}
                      </Text>
                      <Group mt="xs" justify="space-between">
                        <Status value={r.state} />
                        <Text size="xs" c="dimmed">
                          {new Date(r.task.updatedAt).toLocaleTimeString()}
                        </Text>
                      </Group>
                    </Paper>
                  </UnstyledButton>
                ))}
              </Stack>
            </ScrollArea>
            {!runs.length && (
              <Text c="dimmed">
                タスクはまだありません。接続と作業許可の完了後、Discordから依頼してください。
              </Text>
            )}
          </Stack>
        </Paper>
      </Grid.Col>
      <Grid.Col span={{ base: 12, md: 8 }}>
        {current && (
          <Card
            title={current.task.title ?? current.task.text}
            description={`Task ${current.task.id} · 実行版 ${current.task.revision}`}
          >
            <Status value={current.state} />
            <Text size="xs" fw={600}>
              WORKSPACE
            </Text>
            <Code block>{current.directory}</Code>
            <Text size="xs" c="dimmed">
              更新 {new Date(current.task.updatedAt).toLocaleString()}
            </Text>
            <ScrollArea mah={500}>
              <Text className="minutes" size="sm">
                {current.result ?? current.progress ?? "進捗を待っています。"}
              </Text>
            </ScrollArea>
            <Group>
              <Button
                color="red"
                variant="light"
                disabled={!active(current.state)}
                onClick={() => invoke("stop", { runId: current.task.runId })}
              >
                タスクを停止
              </Button>
            </Group>
            <Form
              key={current.task.runId}
              fields={[
                { key: "port", label: "この実行のプレビュー用ローカルポート" },
              ]}
              submit={(data) =>
                action("preview", {
                  ...data,
                  port: Number(data.port),
                  runId: current.task.runId,
                })
              }
              label="プレビューを明示的に登録"
            />
          </Card>
        )}
      </Grid.Col>
    </Grid>
  );
}
