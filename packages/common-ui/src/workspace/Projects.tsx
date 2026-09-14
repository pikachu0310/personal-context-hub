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
            </Card>
          ))}
        </Stack>
      )}
    </>
  );
}
