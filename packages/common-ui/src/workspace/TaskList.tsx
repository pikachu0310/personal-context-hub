import {
  Button,
  Code,
  Group,
  Modal,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useState } from "react";
import type { Project, Task } from "@ido/common/contracts/protocol";
import { Card } from "../components/Card.js";
import { Status } from "../components/Status.js";
import type { Action } from "../types.js";
export function TaskList({
  tasks,
  projects,
  control,
  preview,
  readonly,
  activity,
  action,
}: {
  tasks: Task[];
  projects: Project[];
  control: (path: string, data: Record<string, unknown>) => void;
  preview: (id: string) => void;
  readonly: boolean;
  activity: boolean;
  action: Action;
}) {
  const [steer, setSteer] = useState<Record<string, string>>({});
  const [artifact, setArtifact] = useState<string>();
  return (
    <Stack>
      <Modal
        opened={artifact !== undefined}
        onClose={() => setArtifact(undefined)}
        title="worktreeの変更内容"
        size="xl"
      >
        <Code block>{artifact}</Code>
      </Modal>
      {tasks.length === 0 && <Text c="dimmed">まだタスクはありません。</Text>}
      {[...tasks].reverse().map((task) => (
        <Card
          key={task.id}
          title={task.text.slice(0, 90)}
          description={`${projects.find((p) => p.id === task.projectId)?.name ?? ""} · 実行版 ${task.revision}`}
        >
          <Group>
            <Status value={task.state} />
            {task.clientId && (
              <Text c="dimmed" size="xs">
                Client {task.clientId.slice(0, 8)}
              </Text>
            )}
            <Text size="xs">{task.progress}</Text>
          </Group>
          {task.result && (
            <Text className="minutes" size="sm">
              {task.result}
            </Text>
          )}
          <Group>
            {!activity && task.clientId && (
              <Button
                variant="default"
                onClick={() =>
                  void action("artifact", { taskId: task.id })
                    .then((r) =>
                      setArtifact(r.error ?? r.patch ?? "変更はありません。"),
                    )
                    .catch((e) => setArtifact(e.message))
                }
              >
                worktreeの変更
              </Button>
            )}
            {task.preview && (
              <Button variant="light" onClick={() => preview(task.id)}>
                アプリを操作
              </Button>
            )}
            {!readonly &&
              ["assigned", "running", "interrupted"].includes(task.state) && (
                <Button
                  variant="light"
                  color="red"
                  onClick={() =>
                    control("task/control", {
                      taskId: task.id,
                      action: "stop",
                    })
                  }
                >
                  停止
                </Button>
              )}
            {!readonly &&
              !activity &&
              ["completed", "failed", "cancelled", "interrupted"].includes(
                task.state,
              ) && (
                <Button
                  variant="default"
                  onClick={() =>
                    control("task/control", {
                      taskId: task.id,
                      action: "retry",
                    })
                  }
                >
                  同じworktreeで再実行
                </Button>
              )}
          </Group>
          {!readonly && ["assigned", "running"].includes(task.state) && (
            <Group align="end">
              <TextInput
                flex={1}
                label="この実行に追加指示"
                value={steer[task.id] ?? ""}
                onChange={(e) =>
                  setSteer({ ...steer, [task.id]: e.currentTarget.value })
                }
              />
              <Button
                disabled={!steer[task.id]}
                onClick={() =>
                  control("task/control", {
                    taskId: task.id,
                    action: "steer",
                    text: steer[task.id],
                  })
                }
              >
                送信
              </Button>
            </Group>
          )}
          {task.history?.length > 0 && (
            <Text size="xs" c="dimmed">
              過去の実行版:{" "}
              {task.history.map((h) => `v${h.revision}`).join(" / ")}
            </Text>
          )}
        </Card>
      ))}
    </Stack>
  );
}
