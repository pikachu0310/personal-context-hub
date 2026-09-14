import { ProjectManagement } from "./ProjectManagement.js";
import { Code, Stack, Text } from "@mantine/core";
import { Card } from "../components/Card.js";
import { Form } from "../components/Form.js";
import type { WorkspaceProps } from "../types.js";
export function Projects({
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
      {page === "projects" && (
        <Stack>
          {admin && state.deletionSync && (
            <Text size="sm" c="dimmed" role="status">
              {state.deletionSync.pendingClients
                ? `Engine側の削除は完了しています。${state.deletionSync.pendingClients}台のClientでローカル履歴の同期を待っています。再接続後に反映されます。`
                : "削除履歴はすべてのClientに同期済みです。"}
            </Text>
          )}
          {!readonly && (
            <Card
              title="プロジェクトを追加"
              description="各Clientが、このプロジェクトと自分のローカルrepoを対応付けます。"
            >
              <Form
                fields={[
                  { key: "name", label: "プロジェクト名" },
                  {
                    key: "remote",
                    label: "Git URL（参考情報）",
                    optional: true,
                  },
                ]}
                submit={(data) => action("projects", data)}
              />
            </Card>
          )}
          {state.projects.map((p) => (
            <Card key={p.id} title={p.name}>
              <Code>{p.id}</Code>
              <Text size="sm">{p.remote}</Text>
              {admin && !readonly && !activity && (
                <ProjectManagement project={p} action={action} />
              )}
            </Card>
          ))}
        </Stack>
      )}
    </>
  );
}
