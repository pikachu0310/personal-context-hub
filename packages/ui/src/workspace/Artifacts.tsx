import { Stack, Text } from "@mantine/core";
import type { WorkspaceProps } from "../types.js";
import { TaskList } from "./TaskList.js";
export function Artifacts({
  state,
  action,
  invoke,
  showPreview,
  activity,
  page,
}: WorkspaceProps) {
  if (page !== "artifacts") return null;
  const tasks = state.tasks.filter(
    (task) => task.result || task.preview || task.clientId,
  );
  return (
    <Stack>
      <Text c="dimmed">
        各タスクの実行結果、worktreeの変更とアプリのプレビューを確認できます。
      </Text>
      <TaskList
        tasks={tasks}
        projects={state.projects}
        action={action}
        control={invoke}
        preview={showPreview}
        readonly
        activity={activity}
      />
    </Stack>
  );
}
