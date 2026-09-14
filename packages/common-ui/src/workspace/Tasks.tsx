import { Stack } from "@mantine/core";
import { Card } from "../components/Card.js";
import { Form } from "../components/Form.js";
import type { WorkspaceProps } from "../types.js";
import { TaskList } from "./TaskList.js";
export function Tasks({
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
      {page === "tasks" && (
        <Stack>
          {!readonly && !activity && (
            <Card
              title="Codexへタスクを依頼"
              description="登録されたrepo・権限・空き枠を満たすClientへ自動で配分します。"
            >
              <Form
                fields={[
                  {
                    key: "projectId",
                    label: "プロジェクト",
                    options: state.projects.map((p) => ({
                      value: p.id,
                      label: p.name,
                    })),
                  },
                  { key: "text", label: "依頼内容", multiline: true },
                  {
                    key: "network",
                    label: "ネットワーク権限",
                    options: [
                      { value: "no", label: "不要" },
                      {
                        value: "yes",
                        label: "許可されたClientで利用",
                      },
                    ],
                  },
                ]}
                initial={{ network: "no" }}
                submit={(data) =>
                  action("tasks", {
                    ...data,
                    network: data.network === "yes",
                    requestId: crypto.randomUUID(),
                  })
                }
                label="自動配分する"
              />
            </Card>
          )}
          <TaskList
            action={action}
            tasks={state.tasks}
            projects={state.projects}
            control={invoke}
            preview={showPreview}
            readonly={readonly}
            activity={activity}
          />
        </Stack>
      )}
    </>
  );
}
