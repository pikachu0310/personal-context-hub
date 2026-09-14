import {
  Anchor,
  Button,
  Code,
  Group,
  NumberInput,
  Paper,
  Stack,
  Switch,
  Text,
} from "@mantine/core";
import { useState } from "react";
import { Card, Form, Status } from "@ido/common-ui";
import type { Action, ClientState, Invoke } from "@ido/common-ui";
import { desktopBridge } from "./desktop.js";
import { ClientRuns } from "./ClientRuns.js";
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
  const [slots, setSlots] = useState<number | string>(state.settings.slots),
    [network, setNetwork] = useState(false);
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
            title="1. 専用Codexでログイン"
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
          <Card
            title="3. プロジェクトとローカルrepoを対応付け"
            description="repoの自動cloneは行いません。新しいworktreeはClient専用領域に作ります。"
          >
            {state.settings.mappings.map((m) => (
              <Paper key={m.projectId} bg="gray.0" p="sm">
                <Text size="sm">
                  {
                    state.settings.projects.find((p) => p.id === m.projectId)
                      ?.name
                  }
                </Text>
                <Code>{m.directory}</Code>
                <Text size="xs">
                  Network {m.network ? "allowed" : "disabled"} · slots {m.slots}
                </Text>
              </Paper>
            ))}
            {!state.allow && (
              <Form
                fields={[
                  {
                    key: "projectId",
                    label: "チームのプロジェクト",
                    options: state.settings.projects.map((p) => ({
                      value: p.id,
                      label: p.name,
                    })),
                  },
                  {
                    key: "directory",
                    label: "ローカルrepoの絶対パス",
                    pick: desktopBridge()?.pickDirectory,
                  },
                ]}
                submit={(data) =>
                  action("mappings", { ...data, network, slots: 1 })
                }
              >
                <Switch
                  label="このプロジェクトで通信を許可する"
                  checked={network}
                  onChange={(e) => setNetwork(e.currentTarget.checked)}
                />
              </Form>
            )}
          </Card>
          <Card
            title="4. この接続で自動実行を許可"
            description="許可したrepo・通信権限の範囲でタスクを受け取ります。権限の追加要求はローカル画面で承認します。"
          >
            <NumberInput
              label="端末全体の同時実行枠"
              min={1}
              max={8}
              value={slots}
              onChange={setSlots}
              w={180}
            />
            <Switch
              label="タスクの自動実行を許可する"
              checked={state.allow}
              onChange={(e) =>
                invoke("allow", {
                  allow: e.currentTarget.checked,
                  slots: Number(slots),
                })
              }
            />
          </Card>
        </>
      ) : (
        <>
          <Card
            title="追加権限の承認"
            description="操作内容を確認して、この実行に限って承認します。"
          >
            {!state.approvals.length && (
              <Text c="dimmed">承認待ちはありません。</Text>
            )}
            {state.approvals.map((a) => (
              <Paper p="md" withBorder key={a.id}>
                <Text fw={600}>{a.method}</Text>
                <Code block>{JSON.stringify(a.params, null, 2)}</Code>
                <Group mt="sm">
                  <Button
                    onClick={() =>
                      invoke("approval", { id: a.id, allow: true })
                    }
                  >
                    この操作を許可
                  </Button>
                  <Button
                    variant="default"
                    onClick={() =>
                      invoke("approval", { id: a.id, allow: false })
                    }
                  >
                    拒否
                  </Button>
                </Group>
              </Paper>
            ))}
          </Card>
          <ClientRuns state={state} action={action} invoke={invoke} />
        </>
      )}
    </Stack>
  );
}
