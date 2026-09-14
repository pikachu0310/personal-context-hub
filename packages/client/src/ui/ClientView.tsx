import { useState } from "react";
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
  const [reconnecting, setReconnecting] = useState(false);
  const [connectionError, setConnectionError] = useState("");
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
          <Card title="この端末の本人情報">
            <Text size="sm">端末ID: {state.settings.deviceId ?? "未登録"}</Text>
            <Text size="sm">
              {state.identity?.status === "created"
                ? "この端末で初めて作成しました。"
                : state.identity?.status === "public key recovered"
                  ? "保存済みの鍵から本人情報を復元しました。"
                  : state.identity?.status === "restored"
                    ? "保存済みの本人情報を復元しました。"
                    : "確認中です。"}
            </Text>
            <Text size="xs" c="dimmed">
              保存先: {state.identity?.directory ?? "確認中"}
            </Text>
            <Text size="xs" c="dimmed">
              ブラウザー・アプリを閉じても、この端末の本人情報は保持されます。
            </Text>
          </Card>
          <Card title="チームのEngineへ接続">
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
                  loading={reconnecting || state.status === "connecting"}
                  disabled={state.connected}
                  onClick={async () => {
                    setReconnecting(true);
                    setConnectionError("");
                    try {
                      await action("reconnect", {});
                    } catch (e) {
                      setConnectionError((e as Error).message);
                    } finally {
                      setReconnecting(false);
                    }
                  }}
                >
                  再接続
                </Button>
                <Button
                  variant="subtle"
                  color="red"
                  onClick={() => invoke("disconnect", {})}
                >
                  接続先を変更
                </Button>
              </Group>
            )}
            {connectionError && (
              <Text c="red" role="alert">
                {connectionError}
              </Text>
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
          <Card
            title="Codexと連携（タスクを実行する場合）"
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
            <Text size="sm">
              {state.account?.status === "available"
                ? `ログイン先: ${state.account.type}${state.account.email ? ` · ${state.account.email}` : ""}`
                : state.account?.status === "signed-out"
                  ? "Codexにログインしていません。"
                  : "Codexアカウント情報を確認できていません。"}
            </Text>
            <Text size="xs" c="dimmed">
              アカウント情報はこの端末だけに表示します。Clientの本人IDはログイン先を変更しても維持します。
            </Text>
            {state.loginUrl && (
              <Anchor href={state.loginUrl} target="_blank" rel="noreferrer">
                ログイン画面をブラウザーで開く
              </Anchor>
            )}
          </Card>
          <Card
            title="Claude Codeでログイン"
            description="Claudeを使う場合に設定します。このPCの公式Claude Codeの認証を利用し、Botへ認証情報を渡しません。"
          >
            <Group>
              <Status value={state.claudeLoginStatus ?? "not checked"} />
              <Button onClick={() => invoke("claude/login", {})}>
                Claudeの公式ログインを開始
              </Button>
              <Button
                variant="light"
                onClick={() => invoke("claude/doctor", {})}
              >
                Claudeの認証状態を確認
              </Button>
            </Group>
            {state.claudeLoginUrl && (
              <Anchor
                href={state.claudeLoginUrl}
                target="_blank"
                rel="noreferrer"
              >
                Claudeのログイン画面を開く
              </Anchor>
            )}
            <Anchor
              href="https://code.claude.com/docs/en/authentication"
              target="_blank"
              rel="noreferrer"
            >
              公式の認証手順
            </Anchor>
          </Card>
        </>
      ) : null}
    </Stack>
  );
}
