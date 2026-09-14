import { Group, Paper, Select, Stack, Text } from "@mantine/core";
import { Card } from "../../../../ui/src/components/Card.js";
import { Form } from "../../../../ui/src/components/Form.js";
import type { Action, AdminState, Invoke } from "../../../../ui/src/types.js";
export function Members({
  state,
  action,
  invoke,
  page,
}: {
  state: AdminState;
  action: Action;
  invoke: Invoke;
  page: string;
}) {
  const admin = state.user.role === "admin";
  return (
    <>
      {page === "members" && admin && (
        <Stack>
          <Card title="メンバーを追加">
            <Form
              fields={[
                { key: "name", label: "ユーザー名" },
                {
                  key: "password",
                  label: "初期パスワード（12文字以上）",
                  secret: true,
                },
                {
                  key: "role",
                  label: "権限",
                  options: [
                    { value: "member", label: "メンバー" },
                    { value: "viewer", label: "閲覧者" },
                    { value: "admin", label: "管理者" },
                  ],
                },
              ]}
              initial={{ role: "member" }}
              submit={(data) => action("users", data)}
            />
          </Card>
          {state.users.map((u) => (
            <Paper p="md" withBorder key={u.id}>
              <Group justify="space-between">
                <Text>{u.name}</Text>
                <Select
                  w={150}
                  value={u.role}
                  disabled={u.id === state.user.id}
                  data={["admin", "member", "viewer"]}
                  onChange={(role) =>
                    invoke("users/role", { userId: u.id, role })
                  }
                />
              </Group>
            </Paper>
          ))}
        </Stack>
      )}
    </>
  );
}
