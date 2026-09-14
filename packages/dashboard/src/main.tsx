import React, { useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  MantineProvider,
  AppShell,
  Group,
  Stack,
  Title,
  Text,
  Button,
  Paper,
  Badge,
  TextInput,
  PasswordInput,
  Textarea,
  Select,
  NumberInput,
  Switch,
  Alert,
  SimpleGrid,
  NavLink,
  Anchor,
  Code,
  Divider,
  Modal,
  Loader,
  ScrollArea,
} from "@mantine/core";
import "@mantine/core/styles.css";
import "./style.css";

type Data = Record<string, any>;
let csrf = "";
let activityToken = "";
async function api(path: string, input?: Data) {
  const response = await fetch("/api/" + path, {
    method: input ? "POST" : "GET",
    headers: {
      "content-type": "application/json",
      "x-csrf-token": csrf,
      ...(activityToken ? { Authorization: `Bearer ${activityToken}` } : {}),
    },
    body: input ? JSON.stringify(input) : undefined,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "接続に失敗しました");
  return data;
}
const errorMessages: Record<string, string> = {
  DISCORD_USER_POLICY_INVALID:
    "許可方法を選び、DiscordユーザーIDを数字で入力してください。改行・カンマ区切りで最大100件指定できます。",
  DISCORD_PLUGIN_NOT_RUNNING:
    "Discordプラグインが停止しています。セットアップの「2. Discord追加」で起動してから、連携をやり直してください。",
  DISCORD_TOKEN_EXCHANGE_FAILED:
    "Discordの認証情報を交換できませんでした。Application ID・Client Secret・Redirect URLを確認し、連携をやり直してください。",
  DISCORD_PLUGIN_TIMEOUT:
    "Discordプラグインの応答がありません。プラグインの接続状態を確認してください。",
  LOGIN_REQUIRED: "ログインしてください。",
  INVALID_LOGIN: "名前またはパスワードを確認してください。",
  REQUEST_FAILED: "操作に失敗しました。設定と接続状態を確認してください。",
  TUNNEL_CREDENTIAL_REQUIRED:
    "ngrokのAuthtoken、またはCloudflareのTunnel tokenを入力してください。",
  TUNNEL_INSTALL_FAILED:
    "トンネルの導入に失敗しました。ネットワークを確認して再試行してください。",
  TUNNEL_START_FAILED:
    "トンネルを起動できませんでした。トークンとngrok側の利用状況を確認してください。",
  TUNNEL_BUSY: "トンネルを準備中です。完了までお待ちください。",
  PUBLIC_HTTPS_REQUIRED: "公開URLにはhttps://で始まるURLを指定してください。",
  PUBLIC_URL_REQUIRED: "先に公開URLを保存してください。",
  PREVIEW_OFFLINE: "プレビューが未登録、停止中、または期限切れです。",
  LINK_DISCORD_IN_DASHBOARD_FIRST:
    "先にEngine管理画面からDiscordアカウントを連携してください。",
};
type Field = {
  key: string;
  label: string;
  secret?: boolean;
  options?: Array<{ value: string; label: string }>;
  multiline?: boolean;
  placeholder?: string;
  optional?: boolean;
};
function Form({
  fields,
  initial = {},
  submit,
  label = "保存",
  children,
}: {
  fields: Field[];
  initial?: Data;
  submit: (data: Data) => Promise<unknown>;
  label?: string;
  children?: React.ReactNode;
}) {
  const [values, setValues] = useState<Data>(initial),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await submit(values);
          for (const f of fields.filter((f) => f.secret))
            setValues((v) => ({ ...v, [f.key]: "" }));
        } catch (e) {
          setError(errorMessages[(e as Error).message] ?? (e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Stack gap="md">
        {fields.map((f) =>
          f.options ? (
            <Select
              key={f.key}
              label={f.label}
              data={f.options}
              value={values[f.key] ?? null}
              onChange={(value) => setValues({ ...values, [f.key]: value })}
              required={!f.optional}
            />
          ) : f.secret ? (
            <PasswordInput
              key={f.key}
              label={f.label}
              value={values[f.key] ?? ""}
              onChange={(e) =>
                setValues({ ...values, [f.key]: e.currentTarget.value })
              }
              required={!f.optional}
              autoComplete="new-password"
            />
          ) : f.multiline ? (
            <Textarea
              key={f.key}
              label={f.label}
              minRows={3}
              autosize
              value={values[f.key] ?? ""}
              onChange={(e) =>
                setValues({ ...values, [f.key]: e.currentTarget.value })
              }
              required={!f.optional}
            />
          ) : (
            <TextInput
              key={f.key}
              label={f.label}
              placeholder={f.placeholder}
              value={values[f.key] ?? ""}
              onChange={(e) =>
                setValues({ ...values, [f.key]: e.currentTarget.value })
              }
              required={!f.optional}
            />
          ),
        )}
        {children}
        {error && <Alert color="red">{error}</Alert>}
        <Button type="submit" loading={busy} w="fit-content">
          {label}
        </Button>
      </Stack>
    </form>
  );
}
function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Paper p="lg" withBorder radius="lg">
      <Stack gap="md">
        <div>
          <Title order={3} size="h4">
            {title}
          </Title>
          {description && (
            <Text c="dimmed" size="sm" mt={5}>
              {description}
            </Text>
          )}
        </div>
        {children}
      </Stack>
    </Paper>
  );
}
function Status({ value }: { value: string }) {
  return (
    <Badge
      variant="light"
      color={
        ["completed", "connected", "authenticated"].includes(value)
          ? "teal"
          : ["failed", "cancelled", "offline"].includes(value)
            ? "red"
            : "blue"
      }
    >
      {value}
    </Badge>
  );
}
function App() {
  const activity =
    location.pathname.startsWith("/activity") ||
    new URLSearchParams(location.search).has("frame_id");
  const [state, setState] = useState<Data>(),
    [error, setError] = useState(""),
    [login, setLogin] = useState(false),
    [page, setPage] = useState("overview"),
    [preview, setPreview] = useState("");
  const refresh = useCallback(async () => {
    try {
      const data = await api(activity ? "activity/state" : "state");
      csrf = data.csrf ?? csrf;
      setState(data);
      setLogin(false);
    } catch (e) {
      if ((e as Error).message === "LOGIN_REQUIRED") setLogin(true);
      else
        setError(errorMessages[(e as Error).message] ?? (e as Error).message);
    }
  }, [activity]);
  useEffect(() => {
    let timer: ReturnType<typeof setInterval>;
    let disposed = false;
    void (async () => {
      if (activity) {
        try {
          const config = await api("activity/config");
          const { DiscordSDK } = await import("@discord/embedded-app-sdk");
          const sdk = new DiscordSDK(config.appId);
          await sdk.ready();
          const { code } = await sdk.commands.authorize({
            client_id: config.appId,
            response_type: "code",
            state: crypto.randomUUID(),
            prompt: "none",
            scope: ["identify"],
          });
          const result = await api("activity/auth", { code });
          activityToken = result.token;
          await sdk.commands.authenticate({ access_token: result.accessToken });
        } catch (e) {
          setError((e as Error).message);
          return;
        }
      }
      if (!disposed) {
        await refresh();
        timer = setInterval(() => void refresh(), 2500);
      }
    })();
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [activity, refresh]);
  const action = async (path: string, data: Data) => {
    const result = await api(path, data);
    await refresh();
    return result;
  };
  const invoke = (path: string, data: Data) =>
    void action(path, data).catch((e) =>
      setError(errorMessages[e.message] ?? e.message),
    );
  const showPreview = async (taskId: string) => {
    try {
      const result = await action(activity ? "activity/preview" : "preview", {
        taskId,
      });
      setPreview(result.url);
    } catch (e) {
      setError(errorMessages[(e as Error).message] ?? (e as Error).message);
    }
  };
  if (login)
    return (
      <main className="login">
        <div>
          <Text className="wordmark">
            IDO<span> / ENGINE</span>
          </Text>
          <Title mt="lg">
            チームの会話を、
            <br />
            動くものに。
          </Title>
          <Text c="dimmed" mt="md">
            自分たちのEngineにログインします。
          </Text>
        </div>
        <Card
          title="ログイン"
          description="初回の管理者作成は起動した端末で行います。"
        >
          <Form
            fields={[
              { key: "name", label: "ユーザー名" },
              { key: "password", label: "パスワード", secret: true },
            ]}
            submit={async (data) => {
              await api("login", data);
              await refresh();
            }}
            label="ログイン"
          />
        </Card>
      </main>
    );
  if (!state)
    return (
      <main className="loading">
        <Text className="wordmark">IDO</Text>
        {error ? <Alert color="red">{error}</Alert> : <Loader />}
      </main>
    );
  const isClient = state.mode === "client",
    admin = state.user?.role === "admin",
    readonly = state.user?.role === "viewer";
  const pages = isClient
    ? [
        ["overview", "接続とセットアップ"],
        ["runs", "実行と承認"],
      ]
    : activity
      ? [
          ["overview", "チームの状況"],
          ["meetings", "議事録"],
          ["tasks", "タスクとプレビュー"],
        ]
      : [
          ["overview", "チームの状況"],
          ["setup", "セットアップ"],
          ["meetings", "会議・議事録"],
          ["projects", "プロジェクト"],
          ["tasks", "タスク・成果物"],
          ["clients", "クライアント"],
          ...(admin
            ? [
                ["members", "メンバー"],
                ["audit", "操作履歴"],
                ["diagnostics", "エラーログ"],
              ]
            : []),
        ];
  return (
    <MantineProvider defaultColorScheme="light">
      <AppShell
        header={{ height: 72 }}
        navbar={{ width: 230, breakpoint: "sm" }}
        padding="xl"
      >
        <AppShell.Header>
          <Group h="100%" px="xl" justify="space-between">
            <Text className="wordmark">
              IDO
              <span>
                {" "}
                / {isClient ? "CLIENT" : activity ? "ACTIVITY" : "ENGINE"}
              </span>
            </Text>
            <Group>
              <Badge
                variant="dot"
                color={isClient && !state.connected ? "gray" : "teal"}
              >
                {isClient ? state.status : state.user.name}
              </Badge>
              {!activity && !isClient && (
                <Button
                  variant="subtle"
                  size="xs"
                  onClick={() => invoke("logout", {})}
                >
                  ログアウト
                </Button>
              )}
            </Group>
          </Group>
        </AppShell.Header>
        <AppShell.Navbar p="md">
          <Stack gap={5}>
            {pages.map(([key, label]) => (
              <NavLink
                key={key}
                label={label}
                active={page === key}
                onClick={() => setPage(key)}
                variant="light"
              />
            ))}
          </Stack>
          <Text size="xs" c="dimmed" mt="auto" p="sm">
            Your context. Your machines.
            <br />
            Protocol 1 · IDO 0.2
          </Text>
        </AppShell.Navbar>
        <AppShell.Main>
          <div className="content">
            <Group justify="space-between" mb="xl">
              <div>
                <Text tt="uppercase" c="teal" fw={700} size="xs" lts={2}>
                  {isClient ? "LOCAL WORKSPACE" : "TEAM WORKSPACE"}
                </Text>
                <Title order={1} mt={5}>
                  {pages.find(([key]) => key === page)?.[1]}
                </Title>
              </div>
              <Button variant="default" onClick={() => void refresh()}>
                更新
              </Button>
            </Group>
            {error && (
              <Alert
                mb="lg"
                color="red"
                withCloseButton
                onClose={() => setError("")}
              >
                {error}
              </Alert>
            )}
            {isClient ? (
              <ClientView
                page={page}
                state={state}
                action={action}
                invoke={invoke}
              />
            ) : (
              <>
                {page === "overview" && (
                  <>
                    <SimpleGrid cols={{ base: 1, sm: 3 }} mb="xl">
                      {[
                        ["会議", state.meetings?.length],
                        [
                          "接続中の端末",
                          state.clients?.filter((c: Data) => c.connected)
                            .length ?? "—",
                        ],
                        [
                          "進行中のタスク",
                          state.tasks?.filter((t: Data) =>
                            ["queued", "assigned", "running"].includes(t.state),
                          ).length,
                        ],
                      ].map(([label, value]) => (
                        <Paper withBorder radius="lg" p="lg" key={label}>
                          <Text c="dimmed" size="sm">
                            {label}
                          </Text>
                          <Text size="36px" fw={600}>
                            {value}
                          </Text>
                        </Paper>
                      ))}
                    </SimpleGrid>
                    <Card
                      title="会話から、次の一歩へ"
                      description="議事録を共有し、同じ文脈から各メンバーのCodexへ仕事を渡します。"
                    >
                      <Group>
                        <Button onClick={() => setPage("meetings")}>
                          会議を開く
                        </Button>
                        <Button
                          variant="light"
                          onClick={() => setPage("tasks")}
                        >
                          タスクを見る
                        </Button>
                        {admin && !activity && (
                          <Button
                            variant="default"
                            onClick={() => setPage("setup")}
                          >
                            セットアップ
                          </Button>
                        )}
                      </Group>
                    </Card>
                    <div className="section">
                      <TaskList
                        tasks={state.tasks ?? []}
                        projects={state.projects ?? []}
                        control={invoke}
                        preview={showPreview}
                        readonly={readonly}
                        activity={activity}
                      />
                    </div>
                  </>
                )}
                {page === "setup" && (
                  <Setup
                    state={state}
                    action={action}
                    invoke={invoke}
                    admin={admin}
                  />
                )}
                {page === "projects" && (
                  <Stack>
                    {admin && (
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
                    {state.projects.map((p: Data) => (
                      <Card key={p.id} title={p.name}>
                        <Code>{p.id}</Code>
                        <Text size="sm">{p.remote}</Text>
                      </Card>
                    ))}
                  </Stack>
                )}
                {page === "meetings" && (
                  <Stack>
                    {!readonly && !activity && (
                      <Card title="新しい会議">
                        <Form
                          fields={[
                            { key: "name", label: "会議名" },
                            {
                              key: "projectId",
                              label: "会議のプロジェクト",
                              optional: true,
                              options: state.projects.map((p: Data) => ({
                                value: p.id,
                                label: p.name,
                              })),
                            },
                          ]}
                          submit={(data) => action("meetings", data)}
                          label="会議を作成"
                        />
                      </Card>
                    )}
                    {state.meetings.map((meeting: Data) => (
                      <Card
                        key={meeting.id}
                        title={meeting.name}
                        description={`${meeting.messages.length} messages`}
                      >
                        <Text className="minutes">
                          {meeting.summary ||
                            "会話を受け付けると、ここに議事録がまとまります。"}
                        </Text>
                        <ScrollArea h={meeting.messages.length ? 180 : 0}>
                          {meeting.messages.slice(-30).map((m: Data) => (
                            <Paper key={m.id} p="sm" mb="xs" bg="gray.0">
                              <Group justify="space-between">
                                <Text size="sm">{m.text}</Text>
                                <Status value={m.stage} />
                              </Group>
                            </Paper>
                          ))}
                        </ScrollArea>
                        {!readonly && (
                          <Form
                            fields={[
                              {
                                key: "text",
                                label: "会話に追加",
                                multiline: true,
                              },
                            ]}
                            submit={(data) =>
                              action(
                                activity ? "activity/message" : "messages",
                                { ...data, meetingId: meeting.id },
                              )
                            }
                            label="会話を送信"
                          />
                        )}
                      </Card>
                    ))}
                  </Stack>
                )}
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
                              options: state.projects.map((p: Data) => ({
                                value: p.id,
                                label: p.name,
                              })),
                            },
                            {
                              key: "meetingId",
                              label: "紐づける会議",
                              options: state.meetings.map((m: Data) => ({
                                value: m.id,
                                label: m.name,
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
                      tasks={state.tasks}
                      projects={state.projects}
                      control={invoke}
                      preview={showPreview}
                      readonly={readonly}
                      activity={activity}
                    />
                  </Stack>
                )}
                {page === "clients" && (
                  <Stack>
                    <Alert color="teal">
                      各メンバーは <Code>npm install -g @ido/client</Code> →{" "}
                      <Code>ido-client start</Code>
                      。ローカル画面にこのEngineのURLを入力し、ブラウザで端末を確認します。
                    </Alert>
                    <PairApproval action={action} />
                    {state.clients.map((d: Data) => (
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
                          <Text size="sm">接続世代 {d.generation}</Text>
                          {(admin || d.userId === state.user.id) && (
                            <Button
                              size="xs"
                              variant="light"
                              color="red"
                              disabled={d.revoked}
                              onClick={() =>
                                invoke("devices/revoke", { deviceId: d.id })
                              }
                            >
                              接続を失効
                            </Button>
                          )}
                        </Group>
                      </Card>
                    ))}
                  </Stack>
                )}
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
                    {state.users.map((u: Data) => (
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
                {page === "diagnostics" && admin && (
                  <Card
                    title="エラーログ"
                    description="最新100件を表示します。再起動後も最大500件を保持します。Discordに表示されたエラーIDで照合できます。"
                  >
                    <Stack>
                      {!(state.diagnostics ?? []).length && (
                        <Text c="dimmed">
                          記録されたエラーはありません。ログ機能の追加前に起きた失敗の詳細は復元できません。
                        </Text>
                      )}
                      {(state.diagnostics ?? []).map((entry: Data) => (
                        <Paper p="md" withBorder key={entry.id}>
                          <Stack gap="xs">
                            <Group justify="space-between">
                              <Text size="sm">
                                {new Date(entry.at).toLocaleString()}
                              </Text>
                              <Badge
                                color={
                                  entry.level === "warning" ? "yellow" : "red"
                                }
                              >
                                {entry.level === "warning"
                                  ? "一部失敗"
                                  : "エラー"}
                              </Badge>
                            </Group>
                            <Text fw={600}>
                              {(
                                {
                                  "audio.transcribe": "文字起こし",
                                  "minutes.generate": "議事録生成",
                                  "answer.generate": "回答生成",
                                  "audio.speak": "読み上げ",
                                  "task.create": "タスク作成",
                                  "input.process": "入力処理",
                                  "input.dispatch": "プラグイン入力",
                                } as Record<string, string>
                              )[entry.operation] ?? entry.operation}{" "}
                              · {entry.source}
                            </Text>
                            <Text>{entry.error.reason}</Text>
                            <Code block>
                              {[
                                `エラーID: ${entry.id}`,
                                `種類: ${entry.error.type}`,
                                entry.error.code &&
                                  `コード: ${entry.error.code}`,
                                entry.error.status &&
                                  `HTTP: ${entry.error.status}`,
                                entry.error.cause &&
                                  `通信原因: ${entry.error.cause}`,
                                entry.error.parameter &&
                                  `対象パラメータ: ${entry.error.parameter}`,
                                entry.model && `モデル: ${entry.model}`,
                                entry.error.requestId &&
                                  `OpenAI Request ID: ${entry.error.requestId}`,
                                entry.eventId && `入力ID: ${entry.eventId}`,
                                entry.meetingId && `会議ID: ${entry.meetingId}`,
                                entry.messageId && `発言ID: ${entry.messageId}`,
                              ]
                                .filter(Boolean)
                                .join("\n")}
                            </Code>
                          </Stack>
                        </Paper>
                      ))}
                    </Stack>
                  </Card>
                )}
                {page === "audit" && admin && (
                  <Card
                    title="操作履歴"
                    description="秘密値や会話内容は記録しません。"
                  >
                    {state.audit.map((event: Data, i: number) => (
                      <Group key={i} justify="space-between">
                        <Text size="sm">
                          {new Date(event.at).toLocaleString()} · {event.action}
                        </Text>
                        <Code>{event.target}</Code>
                      </Group>
                    ))}
                  </Card>
                )}
                {!activity &&
                  location.pathname.startsWith("/pair/") &&
                  page !== "clients" && (
                    <div className="section">
                      <PairApproval action={action} />
                    </div>
                  )}
              </>
            )}
          </div>
        </AppShell.Main>
      </AppShell>
      <Modal
        opened={!!preview}
        onClose={() => setPreview("")}
        title="実行版プレビュー · 15分で期限切れ"
        size="95%"
      >
        <iframe
          title="タスクのプレビュー"
          src={preview}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          className="preview"
        />
        <Text c="dimmed" size="xs">
          このアプリには管理セッションを渡していません。外部OAuth・WebRTCには対応しません。
        </Text>
      </Modal>
    </MantineProvider>
  );
}
function TaskList({
  tasks,
  projects,
  control,
  preview,
  readonly,
  activity,
}: {
  tasks: Data[];
  projects: Data[];
  control: (path: string, data: Data) => void;
  preview: (id: string) => void;
  readonly: boolean;
  activity: boolean;
}) {
  const [steer, setSteer] = useState<Record<string, string>>({});
  const [artifact, setArtifact] = useState<string>();
  return (
    <Stack>
      <Modal
        opened={artifact !== undefined}
        onClose={() => setArtifact(undefined)}
        title="worktreeの変更内容"
        size="xl"
      >
        <Code block>{artifact}</Code>
      </Modal>
      {tasks.length === 0 && <Text c="dimmed">まだタスクはありません。</Text>}
      {[...tasks].reverse().map((task) => (
        <Card
          key={task.id}
          title={task.text.slice(0, 90)}
          description={`${projects.find((p) => p.id === task.projectId)?.name ?? ""} · 実行版 ${task.revision}`}
        >
          <Group>
            <Status value={task.state} />
            {task.clientId && (
              <Text c="dimmed" size="xs">
                Client {task.clientId.slice(0, 8)}
              </Text>
            )}
            <Text size="xs">{task.progress}</Text>
          </Group>
          {task.result && (
            <Text className="minutes" size="sm">
              {task.result}
            </Text>
          )}
          <Group>
            {!activity && task.clientId && (
              <Button
                variant="default"
                onClick={() =>
                  void api("artifact", { taskId: task.id })
                    .then((r) =>
                      setArtifact(r.error ?? r.patch ?? "変更はありません。"),
                    )
                    .catch((e) => setArtifact(e.message))
                }
              >
                worktreeの変更
              </Button>
            )}
            {task.preview && (
              <Button variant="light" onClick={() => preview(task.id)}>
                アプリを操作
              </Button>
            )}
            {!readonly &&
              ["assigned", "running", "interrupted"].includes(task.state) && (
                <Button
                  variant="light"
                  color="red"
                  onClick={() =>
                    control(activity ? "activity/control" : "task/control", {
                      taskId: task.id,
                      action: "stop",
                    })
                  }
                >
                  停止
                </Button>
              )}
            {!readonly &&
              !activity &&
              ["completed", "failed", "cancelled", "interrupted"].includes(
                task.state,
              ) && (
                <Button
                  variant="default"
                  onClick={() =>
                    control("task/control", {
                      taskId: task.id,
                      action: "retry",
                    })
                  }
                >
                  同じworktreeで再実行
                </Button>
              )}
          </Group>
          {!readonly && ["assigned", "running"].includes(task.state) && (
            <Group align="end">
              <TextInput
                flex={1}
                label="この実行に追加指示"
                value={steer[task.id] ?? ""}
                onChange={(e) =>
                  setSteer({ ...steer, [task.id]: e.currentTarget.value })
                }
              />
              <Button
                disabled={!steer[task.id]}
                onClick={() =>
                  control(activity ? "activity/control" : "task/control", {
                    taskId: task.id,
                    action: "steer",
                    text: steer[task.id],
                  })
                }
              >
                送信
              </Button>
            </Group>
          )}
          {task.history?.length > 0 && (
            <Text size="xs" c="dimmed">
              過去の実行版:{" "}
              {task.history.map((h: Data) => `v${h.revision}`).join(" / ")}
            </Text>
          )}
        </Card>
      ))}
    </Stack>
  );
}
function PairApproval({
  action,
}: {
  action: (path: string, data: Data) => Promise<any>;
}) {
  const [pair, setPair] = useState<Data>(),
    [message, setMessage] = useState("");
  const pairId = location.pathname.match(/^\/pair\/([\w-]+)$/)?.[1];
  useEffect(() => {
    if (pairId)
      void api("pair/" + pairId)
        .then(setPair)
        .catch((e) => setMessage(e.message));
  }, [pairId]);
  if (!pairId) return null;
  return (
    <Card
      title="この端末をチームに接続"
      description="自分のClient画面に出ている確認値と一致することを確認してください。"
    >
      {pair && (
        <>
          <Text>{pair.name}</Text>
          <Code block>{pair.fingerprint}</Code>
          <Button
            onClick={() =>
              void action("pair/approve", { id: pairId })
                .then(() => {
                  setPair(undefined);
                  history.replaceState(null, "", "/");
                  setMessage("承認しました。Clientの画面へ戻ってください。");
                })
                .catch((e) => setMessage(e.message))
            }
          >
            この端末を承認する
          </Button>
        </>
      )}
      {message && <Text>{message}</Text>}
    </Card>
  );
}
function Setup({
  state,
  action,
  invoke,
  admin,
}: {
  state: Data;
  action: (path: string, data: Data) => Promise<any>;
  invoke: (path: string, data: Data) => void;
  admin: boolean;
}) {
  const [guide, setGuide] = useState(true),
    [step, setStep] = useState(0),
    [diagnosis, setDiagnosis] = useState(""),
    [channels, setChannels] = useState<Data[]>([]);
  if (!admin)
    return (
      <Card
        title="Discordアカウントを連携"
        description="Activityを使うには、EngineのメンバーとDiscordの本人確認を対応付けます。"
      >
        <Button
          onClick={() =>
            void action("discord/link", {}).then((r) => location.assign(r.url))
          }
        >
          Discordで本人確認
        </Button>
      </Card>
    );
  const labels = ["OpenAI", "Discord追加", "Bot設定", "Activity", "公開URL"];
  return (
    <Stack>
      <Group>
        {labels.map((label, i) => (
          <Button
            key={label}
            size="sm"
            variant={step === i ? "filled" : "light"}
            onClick={() => setStep(i)}
          >
            {i + 1}. {label}
          </Button>
        ))}
      </Group>
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          説明のスキップは設定・診断の完了にはなりません。
        </Text>
        <Button size="xs" variant="subtle" onClick={() => setGuide(!guide)}>
          {guide ? "説明をスキップ" : "説明を再表示"}
        </Button>
      </Group>
      {step === 0 && (
        <Card
          title="1. 会話を処理するOpenAI API"
          description="APIキーはEngineの資格情報ストアへ保存されます。"
        >
          <Status
            value={state.secrets.openai ? "configured" : "not configured"}
          />
          <Form
            fields={[{ key: "openai", label: "OpenAI APIキー", secret: true }]}
            submit={(data) => action("settings", data)}
          />
          <Button
            variant="light"
            onClick={() =>
              void action("doctor/openai", {})
                .then(() =>
                  setDiagnosis(
                    "OpenAI: 認証とモデル一覧取得に成功しました。文字起こし・生成の利用枠はこの診断では確認しません。",
                  ),
                )
                .catch(() => setDiagnosis("OpenAI: 接続できませんでした"))
            }
          >
            接続診断
          </Button>
        </Card>
      )}
      {step === 1 && (
        <Card
          title="2. Discordプラグイン"
          description="Botの音声・テキスト入出力とActivityを追加します。"
        >
          {guide && (
            <Text size="sm">
              必要なライブラリを専用領域に導入します。Discordを停止しても、この管理画面とタスク台帳は使えます。
            </Text>
          )}
          <Text size="sm">
            起動後、Discordで音声チャンネルに入り /join
            を実行してください。退出は同じ通話で /leave
            を実行します。起動だけでは通話に参加しません。
          </Text>
          {state.plugins.status === "command-registration-failed" && (
            <Alert color="red">
              /join・/leave を登録できませんでした。Botのサーバー参加と
              applications.commands
              の招待スコープを確認し、起動し直してください。
            </Alert>
          )}
          <Group>
            <Status value={state.plugins.status} />
            <Button
              loading={state.plugins.busy}
              onClick={() =>
                invoke("plugins/install", {
                  version: state.plugins.manifest.version,
                })
              }
            >
              {state.plugins.installed ? "同じ版を再導入" : "Discordを追加"} ·{" "}
              {state.plugins.manifest.version}
            </Button>
            <Button variant="light" onClick={() => invoke("plugins/start", {})}>
              起動
            </Button>
            <Button
              variant="default"
              onClick={() => invoke("plugins/stop", {})}
            >
              停止
            </Button>
          </Group>
        </Card>
      )}
      {step === 2 && (
        <Card title="3. Botの作成と接続">
          {guide && (
            <>
              <Text size="sm">
                Developer PortalでアプリとBotを作成し、Message Content
                Intentを有効にしてください。招待時はチャンネル閲覧・メッセージ送信・音声接続の権限を許可します。音声は通話に参加して
                /join
                で開始します。文字起こしすることを参加者へ案内してください。
              </Text>
              <Anchor
                href="https://discord.com/developers/applications"
                target="_blank"
              >
                Discord Developer Portalを開く
              </Anchor>
            </>
          )}
          <Form
            initial={{
              ...state.discord,
              userPolicy: state.discord?.userPolicy ?? "all",
            }}
            fields={[
              {
                key: "botToken",
                label: "Botトークン（変更時のみ）",
                secret: true,
                optional: true,
              },
              { key: "guildId", label: "Guild ID" },
              {
                key: "userPolicy",
                label: "発言・タスク操作を受け付けるユーザー",
                options: [
                  { value: "all", label: "全員を許可（既定）" },
                  { value: "allowlist", label: "指定したユーザーIDだけ許可" },
                ],
              },
              {
                key: "allowedUserIds",
                label: "許可するDiscordユーザーID（改行またはカンマ区切り）",
                multiline: true,
                optional: true,
              },
              {
                key: "textChannelId",
                label: "テキストチャンネル",
                ...(channels.length
                  ? {
                      options: channels
                        .filter((c) => c.type === 0)
                        .map((c) => ({ value: c.id, label: c.name })),
                    }
                  : {}),
              },
              {
                key: "projectId",
                label: "タスクのプロジェクト",
                options: state.projects.map((p: Data) => ({
                  value: p.id,
                  label: p.name,
                })),
              },
              {
                key: "meetingId",
                label: "会話を保存する会議",
                options: state.meetings.map((m: Data) => ({
                  value: m.id,
                  label: m.name,
                })),
              },
            ]}
            submit={(data) =>
              action("settings", {
                botToken: data.botToken,
                discord: { ...state.discord, ...data, botToken: undefined },
              })
            }
          />
          <Text size="sm">
            既定では /join
            で参加した通話と設定したテキストチャンネルの全員が、未連携でも発言・タスク依頼・停止・追加指示を行えます。
            ユーザーIDで絞り込む場合は「指定したユーザーIDだけ許可」を選びます。空欄なら誰も許可しません。保存すると受付対象の変更はすぐに反映されます。
            Activity・管理画面へのログインは引き続き本人確認が必要です。
          </Text>
          <Text size="sm">
            /ido quiet で読み上げ停止、/ido context で議事録全文、/ido ask
            で質問できます。 /ido stop・/ido steer
            で既存タスクを操作できます。「井戸Bot、今のタスクを止めて」「井戸Bot、今のタスクに追加で、テストも実行して」のような呼びかけも使えます。
          </Text>
          <Button
            variant="light"
            onClick={() =>
              void action("discord/channels", {
                guildId: state.discord?.guildId,
              })
                .then((r) => setChannels(r.channels))
                .catch((e) => setDiagnosis(e.message))
            }
          >
            保存したBotでチャンネルを取得・診断
          </Button>
        </Card>
      )}
      {step === 3 && (
        <Card title="4. Activityと本人確認">
          {guide && (
            <>
              <Text size="sm">
                アプリでActivitiesを有効にし、下のOAuth RedirectとURL
                Mappingを登録します。開発中はDiscordのテスター・チーム向け利用条件を確認してください。
              </Text>
              <Anchor
                href="https://docs.discord.com/developers/activities/building-an-activity"
                target="_blank"
              >
                Discord公式のActivity設定手順
              </Anchor>
            </>
          )}
          <Form
            fields={[
              { key: "appId", label: "Application ID" },
              {
                key: "clientSecret",
                label: "OAuth Client Secret",
                secret: true,
                optional: true,
              },
            ]}
            initial={{ appId: state.discord?.appId }}
            submit={(data) =>
              action("settings", {
                clientSecret: data.clientSecret,
                discord: { ...state.discord, appId: data.appId },
              })
            }
          />
          <Code
            block
          >{`OAuth Redirect: ${state.config.engineUrl ?? location.origin}/api/discord/callback\nURL Mapping / → ${state.config.engineUrl ?? "Engine公開URL"}\nActivity entry: /activity`}</Code>
          <Button
            variant="light"
            onClick={() =>
              void action("discord/link", {}).then((r) =>
                location.assign(r.url),
              )
            }
          >
            自分のDiscordを連携
          </Button>
        </Card>
      )}
      {step === 4 && (
        <Card
          title="5. 公開先とトンネル"
          description="公開URLは1つ。生成アプリは /preview/ 以下で表示します。"
        >
          <Text size="sm">
            同じPCのローカルテストやBotだけの利用では、この手順はスキップできます。
          </Text>
          <Divider label="ngrokでかんたん公開" />
          {guide && (
            <Text size="sm">
              ngrokにログインしてAuthtokenをコピーし、下に入力してください。必要なライブラリの導入・トンネル起動・公開URLの保存まで自動で行います。URLを空欄にすると、アカウントに割り当てられた開発用ドメインを利用します。
            </Text>
          )}
          <Anchor
            href="https://dashboard.ngrok.com/get-started/your-authtoken"
            target="_blank"
          >
            ngrokのAuthtokenを取得
          </Anchor>
          <Form
            fields={[
              {
                key: "token",
                label: "ngrok Authtoken（保存済みなら省略可）",
                secret: true,
                optional: true,
              },
              {
                key: "engineUrl",
                label: "ngrok公開URL（省略すると自動取得）",
                optional: true,
                placeholder: "https://your-domain.ngrok-free.app",
              },
            ]}
            submit={(data) =>
              action("tunnels/start", { ...data, provider: "ngrok" })
            }
            label="ngrokで公開する"
          />
          <Group>
            <Status value={state.tunnels.status} />
            {state.tunnels.busy && <Loader size="xs" />}
            <Button
              variant="default"
              disabled={state.tunnels.busy}
              onClick={() => invoke("tunnels/stop", {})}
            >
              停止
            </Button>
          </Group>
          {state.tunnels.error && (
            <Alert color="red">
              {errorMessages[state.tunnels.error] ?? state.tunnels.error}
            </Alert>
          )}
          {state.config.engineUrl && (
            <Alert title="保存された公開URL">
              <Anchor href={state.config.engineUrl} target="_blank">
                {state.config.engineUrl}
              </Anchor>
              <Text size="sm">
                停止中はアクセスできません。起動後は接続診断を実行してください。
              </Text>
            </Alert>
          )}
          <Text size="sm">
            無料プランでは初回アクセス時にngrokの確認画面が出る場合があります。Discord
            Activity内での表示も確認してください。
          </Text>
          <Divider label="Cloudflare・既存URLを使う場合" />
          {guide && (
            <Text size="sm">
              Cloudflareでは1つの公開ホスト名を http://localhost:4310
              に転送してください。手動で公開する場合も転送先は同じです。URL変更後はDiscordのMapping・OAuth
              Redirect更新とClientの再登録が必要です。
            </Text>
          )}
          <Form
            fields={[
              {
                key: "provider",
                label: "公開方法",
                options: [
                  { value: "manual", label: "既存のHTTPS URL" },
                  { value: "cloudflare", label: "Cloudflare Tunnel" },
                ],
              },
              {
                key: "engineUrl",
                label: "公開URL",
                placeholder: "https://ido.example.com",
              },
            ]}
            initial={{
              provider:
                state.config.provider === "cloudflare"
                  ? "cloudflare"
                  : "manual",
              engineUrl: state.config.engineUrl,
            }}
            submit={(data) => action("public", data)}
          />
          {state.config.provider === "cloudflare" && (
            <Form
              fields={[
                {
                  key: "token",
                  label: "Cloudflare Tunnel token（保存済みなら省略可）",
                  secret: true,
                  optional: true,
                },
              ]}
              submit={(data) =>
                action("tunnels/start", { ...data, provider: "cloudflare" })
              }
              label="Cloudflareで公開する"
            />
          )}
          <Button
            variant="light"
            onClick={() =>
              void action("tunnels/doctor", {})
                .then((r) => setDiagnosis(JSON.stringify(r, null, 2)))
                .catch((e) => setDiagnosis(e.message))
            }
          >
            HTTPS・接続診断
          </Button>
          <Text size="sm">
            別端末のClient接続とDiscord内Activityは、それぞれ実際に操作して確認してください。
          </Text>
        </Card>
      )}
      {diagnosis && (
        <Alert>
          <Text className="minutes">{diagnosis}</Text>
        </Alert>
      )}
    </Stack>
  );
}
function ClientView({
  page,
  state,
  action,
  invoke,
}: {
  page: string;
  state: Data;
  action: (path: string, data: Data) => Promise<any>;
  invoke: (path: string, data: Data) => void;
}) {
  const [slots, setSlots] = useState<number | string>(state.settings.slots),
    [network, setNetwork] = useState(false);
  return (
    <Stack>
      {page === "overview" ? (
        <>
          <Card
            title="1. 専用Codexでログイン"
            description="普段のCodexとは認証・設定を分離します。公式ログインの案内は起動したターミナルに表示されます。"
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
          </Card>
          <Card title="2. チームのEngineへ接続">
            <Status value={state.status} />
            {!state.settings.deviceId && (
              <Form
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
            {state.settings.mappings.map((m: Data) => (
              <Paper key={m.projectId} bg="gray.0" p="sm">
                <Text size="sm">
                  {
                    state.settings.projects.find(
                      (p: Data) => p.id === m.projectId,
                    )?.name
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
                    options: state.settings.projects.map((p: Data) => ({
                      value: p.id,
                      label: p.name,
                    })),
                  },
                  { key: "directory", label: "ローカルrepoの絶対パス" },
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
            {state.approvals.map((a: Data) => (
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
          {state.runs.map((r: Data) => (
            <Card
              key={r.task.runId}
              title={r.task.text}
              description={`実行版 ${r.task.revision}`}
            >
              <Status value={r.state} />
              <Code block>{r.directory}</Code>
              <Text className="minutes" size="sm">
                {r.result ?? r.progress}
              </Text>
              <Group>
                <Button
                  color="red"
                  variant="light"
                  onClick={() => invoke("stop", { runId: r.task.runId })}
                >
                  停止
                </Button>
              </Group>
              <Form
                fields={[
                  {
                    key: "port",
                    label: "この実行のプレビュー用ローカルポート",
                  },
                ]}
                submit={(data) =>
                  action("preview", {
                    ...data,
                    port: Number(data.port),
                    runId: r.task.runId,
                  })
                }
                label="プレビューを明示的に登録"
              />
            </Card>
          ))}
        </>
      )}
    </Stack>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <MantineProvider>
      <App />
    </MantineProvider>
  </React.StrictMode>,
);
