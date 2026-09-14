import { Badge, Button, Code, Group, Stack, Table, Text } from "@mantine/core";
import { Status } from "@ido/common-ui";
import type { Action, AdminState, Invoke } from "@ido/common-ui";
import { PairApproval } from "../PairApproval.js";

export function Clients({
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
  if (page !== "clients") return null;
  const admin = state.user.role === "admin";
  const clients = state.clients.filter((device) => !device.revoked);
  const pending = (state.pendingClients ?? []).filter(
    (pair) => pair.expires > Date.now(),
  );
  return (
    <Stack gap="sm">
      <PairApproval action={action} />
      <Group gap="lg">
        <Text size="sm" c="dimmed">
          有効な接続 {clients.length} · リクエスト中 {pending.length}
        </Text>
      </Group>
      <div className="admin-table-scroll">
        <Table
          className="admin-table"
          horizontalSpacing="sm"
          verticalSpacing={8}
          highlightOnHover
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th>端末</Table.Th>
              <Table.Th>接続状態</Table.Th>
              <Table.Th>Codex</Table.Th>
              <Table.Th>同時実行</Table.Th>
              <Table.Th>プロジェクト</Table.Th>
              <Table.Th>操作</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {clients.map((device) => (
              <Table.Tr key={device.id}>
                <Table.Td className="admin-target">
                  <Text size="sm" fw={500}>
                    {device.name}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Status value={device.connected ? "connected" : "offline"} />
                </Table.Td>
                <Table.Td>
                  <Text
                    size="sm"
                    c={device.codexConnected ? undefined : "dimmed"}
                  >
                    {device.codexConnected ? "連携済み" : "未連携"}
                  </Text>
                </Table.Td>
                <Table.Td>{device.slots}</Table.Td>
                <Table.Td>{device.grants.length}</Table.Td>
                <Table.Td>
                  {(admin || device.userId === state.user.id) && (
                    <Button
                      size="compact-xs"
                      variant="subtle"
                      color="red"
                      onClick={() =>
                        invoke("devices/revoke", { deviceId: device.id })
                      }
                    >
                      接続を失効
                    </Button>
                  )}
                </Table.Td>
              </Table.Tr>
            ))}
            {pending.map((pair) => (
              <Table.Tr key={pair.id}>
                <Table.Td className="admin-target">
                  <Text size="sm" fw={500}>
                    {pair.name}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Badge color="yellow" variant="light">
                    リクエスト中
                  </Badge>
                </Table.Td>
                <Table.Td colSpan={3}>
                  <Text size="xs" c="dimmed">
                    確認期限 {new Date(pair.expires).toLocaleString()}
                  </Text>
                </Table.Td>
                <Table.Td>
                  <Button
                    component="a"
                    href={`/admin/pair/${encodeURIComponent(pair.id)}`}
                    size="compact-xs"
                    variant="light"
                  >
                    端末を確認
                  </Button>
                </Table.Td>
              </Table.Tr>
            ))}
            {!clients.length && !pending.length && (
              <Table.Tr>
                <Table.Td colSpan={6}>
                  <Text size="sm" c="dimmed">
                    有効な接続・接続リクエストはありません。
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </div>
      <Text size="xs" c="dimmed">
        端末を追加: <Code>npm install -g @ido/client</Code> →{" "}
        <Code>ido-client start</Code> → EngineのURLを入力
      </Text>
    </Stack>
  );
}
