import { Alert, Button, Code, Group, Stack, Text } from "@mantine/core";
import { Card, Status } from "@ido/common-ui";
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
  const admin = state.user.role === "admin";
  return (
    <>
      {page === "clients" && (
        <Stack>
          <Alert color="teal">
            各参加者は <Code>npm install -g @ido/client</Code> →{" "}
            <Code>ido-client start</Code>
            。ローカル画面にこのEngineのURLを入力し、ブラウザで端末を確認します。
          </Alert>
          <PairApproval action={action} />
          {state.clients.map((d) => (
            <Card
              key={d.id}
              title={d.name}
              description={`同時実行 ${d.slots} · ${d.grants.length} projects`}
            >
              <Group>
                <Status
                  value={
                    d.revoked
                      ? "revoked"
                      : d.connected
                        ? "connected"
                        : "offline"
                  }
                />
                <Text size="sm">
                  {d.codexConnected
                    ? "Codex連携済み"
                    : "Codex未連携・タスク割り当てなし"}
                </Text>
                {(admin || d.userId === state.user.id) && (
                  <Button
                    size="xs"
                    variant="light"
                    color="red"
                    disabled={d.revoked}
                    onClick={() => invoke("devices/revoke", { deviceId: d.id })}
                  >
                    接続を失効
                  </Button>
                )}
              </Group>
            </Card>
          ))}
        </Stack>
      )}
    </>
  );
}
