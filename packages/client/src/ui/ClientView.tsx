import { Anchor, Button, Code, Group, Paper, Stack, Text } from "@mantine/core";
import { Card, Form, Status } from "@ido/common-ui";
import type { Action, ClientState, Invoke } from "@ido/common-ui";

export function ClientView({
  page,
  state,
  action,
  invoke,
}: {
  page: string;
  state: ClientState;
  action: Action;
  invoke: Invoke;
}) {
  return (
    <Stack>
      {state.desktop && (
        <Paper p="md" withBorder>
          <Group justify="space-between">
            <Text fw={600}>{state.desktop.name}</Text>
            <Text size="sm" c="dimmed">
              v{state.desktop.version} · {state.desktop.platform} · PID{" "}
              {state.desktop.pid}
            </Text>
          </Group>
          <Text size="xs" c="dimmed">
            アプリを終了すると、このアプリのタスク実行と接続も停止します。
          </Text>
        </Paper>
      )}
      {page === "overview" ? (
        <>
          <Card
            title="1. Codexと連携（タスクを実行する場合）"
            description="普段のCodexとは認証・設定を分離します。ブラウザーでOpenAIの公式ログインを完了してください。"
          >
            <Group>
              <Status value={state.loginStatus} />
              <Button onClick={() => invoke("codex/login", {})}>
                公式ログインを開始
              </Button>
              <Button
                variant="light"
                onClick={() => invoke("codex/doctor", {})}
              >
                ログイン状態を確認
              </Button>
            </Group>
            {state.loginUrl && (
              <Anchor href={state.loginUrl} target="_blank" rel="noreferrer">
                ログイン画面をブラウザーで開く
              </Anchor>
            )}
          </Card>
          <Card title="2. チームのEngineへ接続">
            <Status value={state.status} />
            {!state.settings.deviceId && (
              <Form
                key={state.suggestedEngine ?? "engine"}
                initial={{ engineUrl: state.suggestedEngine ?? "" }}
                fields={[
                  {
                    key: "engineUrl",
                    label: "EngineのURL",
                    placeholder: "https://engine.example.com",
                  },
                ]}
                submit={(data) => action("pair", data)}
                label="接続の確認へ"
              />
            )}
            {state.settings.deviceId && (
              <Group>
                <Text size="sm">{state.settings.engineUrl}</Text>
                <Button
                  variant="subtle"
                  color="red"
                  onClick={() => invoke("disconnect", {})}
                >
                  接続先を変更
                </Button>
              </Group>
            )}
            {state.pairing && (
              <>
                <Anchor href={state.pairing.url} target="_blank">
                  Engineへログインして、この端末を承認する
                </Anchor>
                <Text size="xs">確認値</Text>
                <Code block>{state.pairing.fingerprint}</Code>
              </>
            )}
          </Card>
        </>
      ) : null}
    </Stack>
  );
}
