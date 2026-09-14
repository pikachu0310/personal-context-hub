import {
  Alert,
  Anchor,
  Badge,
  Button,
  Code,
  Group,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useState } from "react";
import { Card, Form, Status } from "@ido/common-ui";
import type { Action, AdminState, ApiResult, Invoke } from "@ido/common-ui";

export function Setup({
  state,
  action,
  invoke,
}: {
  state: AdminState;
  action: Action;
  invoke: Invoke;
}) {
  const [guide, setGuide] = useState(true);
  const [step, setStep] = useState(0);
  const [complete, setComplete] = useState(false);
  const [provider, setProvider] = useState(state.config.provider || "manual");
  const [diagnosis, setDiagnosis] = useState("");
  const [checking, setChecking] = useState(false);
  const [diagnosisError, setDiagnosisError] = useState("");
  const [selectedPlugin, setSelectedPlugin] = useState<string>();
  const [pluginError, setPluginError] = useState("");
  const admin = state.user.role === "admin";
  const steps = [
    {
      title: "OpenAI",
      requirement: "必須",
      status: state.secrets.openai ? "設定済み" : "未設定",
    },
    {
      title: "公開URL",
      requirement: "外部アクセス時",
      status: state.config.engineUrl ? "設定済み" : "ローカルのみでも利用可能",
    },
    {
      title: "プラグイン接続",
      requirement: "任意",
      status: "必要な機能だけ追加",
    },
  ];
  const linkAccount = (basePath: string) => {
    void fetch(`${basePath}/link`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-csrf-token": state.csrf,
      },
      body: "{}",
    })
      .then(async (response) => {
        const result = (await response.json()) as ApiResult;
        if (!response.ok) throw new Error(result.error);
        if (result.url) location.assign(result.url);
      })
      .catch((error) => alert(error.message));
  };
  return (
    <Stack>
      <Group justify="space-between">
        <Text c="dimmed">基本設定を済ませて、必要な機能を追加しましょう。</Text>
        <Button variant="subtle" onClick={() => setGuide(!guide)}>
          {guide ? "説明をスキップ" : "説明を再表示"}
        </Button>
      </Group>
      {guide && (
        <Alert>
          会議・議事録・タスクは <Anchor href="/dashboard/">Dashboard</Anchor>{" "}
          で操作します。 プラグイン停止中も、この管理画面で設定・復旧できます。
        </Alert>
      )}
      {admin && (
        <>
          <SimpleGrid
            type="container"
            cols={{ base: 1, "52em": 3 }}
            autoRows="1fr"
          >
            {steps.map((item, index) => (
              <UnstyledButton
                key={item.title}
                style={{ display: "flex", minWidth: 0 }}
                onClick={() => {
                  setStep(index);
                  setComplete(false);
                }}
                aria-current={step === index ? "step" : undefined}
                aria-label={`${index + 1} ${item.title}`}
              >
                <Paper
                  withBorder
                  radius="lg"
                  p="md"
                  w="100%"
                  h="100%"
                  bg={
                    step === index
                      ? "var(--mantine-color-blue-light)"
                      : undefined
                  }
                >
                  <Stack gap="xs">
                    <Group
                      justify="space-between"
                      align="flex-start"
                      wrap="nowrap"
                    >
                      <Text fw={600}>
                        {index + 1}　{item.title}
                      </Text>
                      <Badge
                        style={{ flexShrink: 0 }}
                        variant="light"
                        color={index === 0 ? "blue" : "gray"}
                      >
                        {item.requirement}
                      </Badge>
                    </Group>
                    <Text size="sm" c="dimmed">
                      {item.status}
                    </Text>
                  </Stack>
                </Paper>
              </UnstyledButton>
            ))}
          </SimpleGrid>
          <Alert title="認証情報の保存先" color="gray">
            <Text size="sm">
              APIキー・プラグインのトークン・トンネルの認証情報は、Engineが動作する端末に保存されます。ブラウザのストレージには保存しません。
            </Text>
            <Code
              block
              mt="xs"
              style={{ overflowWrap: "anywhere", whiteSpace: "pre-wrap" }}
            >
              {state.credentialStorage?.path ??
                "Engineのデータディレクトリ / secrets.json"}
            </Code>
            <Text size="xs" mt="xs" c="dimmed">
              {state.credentialStorage?.backend === "file"
                ? "このファイルは暗号化されていません。画面には保存状態だけを表示し、保存済みの実値は返しません。"
                : `保存方式: ${state.credentialStorage?.backend ?? "Engineの設定に従います"}。画面には保存状態だけを表示します。`}
            </Text>
          </Alert>
          {complete && (
            <Alert title="基本設定が完了しました" color="teal">
              プラグインは必要になったときに追加できます。
              <Group mt="sm">
                <Button component="a" href="/dashboard/">
                  Dashboardを開く
                </Button>
              </Group>
            </Alert>
          )}
          {step === 0 && (
            <Card
              title="OpenAIを接続"
              description="会話の音声処理などに使うAPIキーを設定します。保存済みと接続確認済みは別の状態です。"
            >
              <Form
                fields={[
                  {
                    key: "openai",
                    label: "OpenAI APIキー",
                    secret: true,
                    configured: state.secrets.openai,
                  },
                ]}
                submit={async (data) => {
                  await action("settings", data);
                  if (data.openai) {
                    setDiagnosis("");
                    setDiagnosisError("");
                  }
                  setStep(1);
                }}
                label="保存して公開URLへ"
              />
              <Group>
                <Text size="sm" c="dimmed" role="status">
                  {diagnosis || "接続確認は未実施"}
                </Text>
                <Button
                  variant="light"
                  loading={checking}
                  disabled={!state.secrets.openai}
                  onClick={async () => {
                    setChecking(true);
                    setDiagnosis("");
                    setDiagnosisError("");
                    try {
                      await action("doctor/openai", {});
                      setDiagnosis("接続確認済み");
                    } catch (error) {
                      setDiagnosisError((error as Error).message);
                    } finally {
                      setChecking(false);
                    }
                  }}
                >
                  保存済みキーの接続を確認
                </Button>
              </Group>
              {diagnosisError && (
                <Alert color="red">
                  接続確認に失敗しました: {diagnosisError}
                </Alert>
              )}
            </Card>
          )}
          {step === 1 && (
            <Card
              title="公開URLを設定"
              description="別のネットワークからのアクセスやDiscord Activityを使う場合に設定します。ローカルで使う場合はスキップできます。"
            >
              <Group>
                <Badge variant="light" color="gray">
                  外部アクセス時に必要
                </Badge>
                <Status value={state.tunnels.status} />
              </Group>
              {state.config.engineUrl && (
                <Text size="sm">
                  設定済みURL: <Code>{state.config.engineUrl}</Code>
                </Text>
              )}
              {state.tunnels.error && (
                <Alert color="red">{state.tunnels.error}</Alert>
              )}
              <Select
                label="公開方法"
                value={provider}
                allowDeselect={false}
                onChange={(value) => setProvider(value!)}
                data={[
                  { value: "manual", label: "既存のHTTPS URL" },
                  { value: "ngrok", label: "ngrokで公開" },
                  { value: "cloudflare", label: "Cloudflareで公開" },
                ]}
              />
              {provider === "manual" ? (
                <Form
                  key="manual"
                  initial={{ engineUrl: state.config.engineUrl ?? "" }}
                  fields={[
                    {
                      key: "engineUrl",
                      label: "公開HTTPS URL",
                      placeholder: "https://ido.example.com",
                    },
                  ]}
                  submit={async (data) => {
                    await action("public", { ...data, provider });
                    setStep(2);
                  }}
                  label="保存してプラグイン接続へ"
                />
              ) : (
                <Form
                  key={provider}
                  initial={{
                    engineUrl:
                      state.config.provider === provider
                        ? (state.config.engineUrl ?? "")
                        : "",
                  }}
                  fields={[
                    {
                      key: "token",
                      label:
                        provider === "ngrok"
                          ? "ngrok Authtoken"
                          : "Cloudflare Tunnelトークン",
                      secret: true,
                      configured: state.secrets.tunnels?.[provider],
                    },
                    ...(provider === "cloudflare"
                      ? [
                          {
                            key: "engineUrl",
                            label: "公開HTTPS URL",
                            placeholder: "https://ido.example.com",
                          },
                        ]
                      : []),
                  ]}
                  submit={async (data) => {
                    await action("tunnels/install", { provider });
                    await action("tunnels/start", { ...data, provider });
                    setStep(2);
                  }}
                  label="トンネルを導入・起動して次へ"
                />
              )}
              <Group>
                <Button
                  variant="light"
                  onClick={() => invoke("tunnels/doctor", {})}
                >
                  トンネル診断
                </Button>
                <Button
                  variant="default"
                  onClick={() => invoke("tunnels/stop", {})}
                >
                  トンネル停止
                </Button>
              </Group>
              <Group justify="space-between">
                <Button variant="subtle" onClick={() => setStep(0)}>
                  OpenAIへ戻る
                </Button>
                <Button variant="subtle" onClick={() => setStep(2)}>
                  {state.config.engineUrl
                    ? "現在の設定で次へ"
                    : "ローカルのみで続ける"}
                </Button>
              </Group>
            </Card>
          )}
          {step === 2 && (
            <>
              {pluginError && <Alert color="red">{pluginError}</Alert>}
              <Card
                title="プラグインを選んで接続"
                description="任意の設定です。Discordを使う場合は、ここでインストールしてからBot・Activityを設定します。"
              >
                <Badge variant="light" color="gray" w="fit-content">
                  すべて追加しなくても完了できます
                </Badge>
                {!state.secrets.openai && (
                  <Alert color="yellow">
                    基本設定を完了するには、OpenAI APIキーを保存してください。
                    <Button variant="subtle" onClick={() => setStep(0)}>
                      OpenAIを設定
                    </Button>
                  </Alert>
                )}
                <Group justify="space-between">
                  <Button variant="subtle" onClick={() => setStep(1)}>
                    公開URLへ戻る
                  </Button>
                  <Button
                    disabled={!state.secrets.openai}
                    onClick={() => setComplete(true)}
                  >
                    プラグインはあとで設定して完了
                  </Button>
                </Group>
              </Card>
              {state.plugins.map((plugin) => {
                const title =
                  plugin.manifest?.title ??
                  (plugin.id === "discord" ? "Discord" : plugin.id);
                const selected = selectedPlugin === plugin.id;
                return (
                  <Card
                    key={plugin.id}
                    title={title}
                    description={
                      plugin.id === "discord"
                        ? "音声・テキスト・Activityを接続します。"
                        : undefined
                    }
                  >
                    <Group>
                      <Badge
                        variant="light"
                        color={plugin.installed ? "teal" : "gray"}
                      >
                        {plugin.installed
                          ? "インストール済み"
                          : "未インストール"}
                      </Badge>
                      <Status value={plugin.status} />
                    </Group>
                    <Group>
                      {!plugin.installed ? (
                        <Button
                          loading={plugin.busy}
                          onClick={async () => {
                            setPluginError("");
                            try {
                              await action("plugins/install", {
                                pluginId: plugin.id,
                                version: plugin.version,
                              });
                              setSelectedPlugin(plugin.id);
                            } catch (error) {
                              setPluginError((error as Error).message);
                            }
                          }}
                        >
                          インストール
                        </Button>
                      ) : (
                        <>
                          {!!plugin.manifest?.fields.length && (
                            <Button
                              variant="light"
                              onClick={() =>
                                setSelectedPlugin(
                                  selected ? undefined : plugin.id,
                                )
                              }
                            >
                              {selected ? "設定を閉じる" : "設定する"}
                            </Button>
                          )}
                          <Button
                            disabled={
                              plugin.busy || plugin.status === "running"
                            }
                            onClick={() =>
                              invoke("plugins/start", { pluginId: plugin.id })
                            }
                          >
                            起動
                          </Button>
                          <Button
                            variant="default"
                            disabled={plugin.busy}
                            onClick={() =>
                              invoke("plugins/stop", { pluginId: plugin.id })
                            }
                          >
                            停止
                          </Button>
                          {!plugin.installed.builtin && (
                            <Button
                              variant="subtle"
                              loading={plugin.busy}
                              onClick={() =>
                                invoke("plugins/install", {
                                  pluginId: plugin.id,
                                  version: plugin.version,
                                })
                              }
                            >
                              同じ版を再導入
                            </Button>
                          )}
                        </>
                      )}
                    </Group>
                    {plugin.installed &&
                      selected &&
                      !!plugin.manifest?.fields.length && (
                        <>
                          <Form
                            key={plugin.id + plugin.manifest.version}
                            initial={plugin.config}
                            fields={[
                              ...plugin.manifest.fields.map((field) => ({
                                key: field.key,
                                label: field.label,
                                secret: field.secret,
                                configured: plugin.secrets?.[field.key],
                                options: field.options,
                                multiline: field.multiline,
                                optional: true,
                              })),
                              {
                                key: "meetingId",
                                label: "会議ID",
                                optional: true,
                              },
                              {
                                key: "projectId",
                                label: "プロジェクトID",
                                optional: true,
                              },
                            ]}
                            submit={(config) =>
                              action("plugins/configure", {
                                pluginId: plugin.id,
                                config,
                              })
                            }
                          />
                          <Text size="sm" c="dimmed">
                            設定を保存したら起動してください。会議・プロジェクトIDはDashboardで確認できます。
                          </Text>
                        </>
                      )}
                    {plugin.installed &&
                      plugin.status === "running" &&
                      plugin.manifest?.capabilities.includes("activity") &&
                      plugin.manifest.web && (
                        <Button
                          variant="light"
                          onClick={() =>
                            linkAccount(plugin.manifest!.web!.basePath)
                          }
                        >
                          アカウントを連携
                        </Button>
                      )}
                  </Card>
                );
              })}
            </>
          )}
        </>
      )}
      {!admin && (
        <>
          <Alert>
            基本設定は管理者が行います。利用するプラグインのアカウントを連携してください。
          </Alert>
          {state.plugins
            .filter(
              (plugin) =>
                plugin.status === "running" &&
                plugin.manifest?.capabilities.includes("activity") &&
                plugin.manifest.web,
            )
            .map((plugin) => (
              <Card
                key={plugin.id}
                title={`${plugin.manifest?.title} の本人確認`}
              >
                <Button
                  onClick={() => linkAccount(plugin.manifest!.web!.basePath)}
                >
                  アカウントを連携
                </Button>
              </Card>
            ))}
        </>
      )}
    </Stack>
  );
}
