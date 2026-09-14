import { Alert, Anchor, Button, Group, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { Card } from "../../../../ui/src/components/Card.js";
import { Form } from "../../../../ui/src/components/Form.js";
import { Status } from "../../../../ui/src/components/Status.js";
import type {
  Action,
  AdminState,
  ApiResult,
  Invoke,
} from "../../../../ui/src/types.js";
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
  return (
    <Stack>
      <Button variant="subtle" onClick={() => setGuide(!guide)}>
        {guide ? "説明をスキップ" : "説明を再表示"}
      </Button>
      {guide && (
        <Alert>
          会議・議事録・タスクは <Anchor href="/dashboard/">Dashboard</Anchor>{" "}
          で操作します。プラグイン停止中も、この管理画面で設定・復旧できます。
        </Alert>
      )}
      {state.user.role === "admin" && (
        <>
          <Card title="OpenAI API">
            <Status
              value={state.secrets.openai ? "configured" : "not configured"}
            />
            <Form
              fields={[
                { key: "openai", label: "OpenAI APIキー", secret: true },
              ]}
              submit={(data) => action("settings", data)}
            />
            <Button variant="light" onClick={() => invoke("doctor/openai", {})}>
              接続診断
            </Button>
          </Card>
          {state.plugins.map((plugin) => (
            <Card key={plugin.id} title={plugin.manifest?.title ?? plugin.id}>
              <Status value={plugin.status} />
              <Group>
                {plugin.id !== "dashboard" && (
                  <Button
                    onClick={() =>
                      invoke("plugins/install", {
                        pluginId: plugin.id,
                        version: "0.2.0",
                      })
                    }
                    loading={plugin.busy}
                  >
                    {plugin.installed ? "同じ版を再導入" : "プラグインを追加"}
                  </Button>
                )}
                <Button
                  onClick={() =>
                    invoke("plugins/start", { pluginId: plugin.id })
                  }
                >
                  起動
                </Button>
                <Button
                  variant="default"
                  onClick={() =>
                    invoke("plugins/stop", { pluginId: plugin.id })
                  }
                >
                  停止
                </Button>
              </Group>
              {!!plugin.manifest?.fields.length && (
                <Form
                  key={plugin.id + plugin.manifest.version}
                  initial={plugin.config}
                  fields={[
                    ...plugin.manifest.fields.map((field) => ({
                      key: field.key,
                      label: field.label,
                      secret: field.secret,
                      options: field.options,
                      multiline: field.multiline,
                      optional: true,
                    })),
                    { key: "meetingId", label: "会議ID" },
                    { key: "projectId", label: "プロジェクトID" },
                  ]}
                  submit={(config) =>
                    action("plugins/configure", { pluginId: plugin.id, config })
                  }
                />
              )}
              {guide && plugin.manifest?.capabilities.includes("audio") && (
                <Text size="sm">
                  設定を保存したら起動してください。入力先の会議・プロジェクトIDはDashboardで確認できます。
                </Text>
              )}
            </Card>
          ))}
          <Card title="公開URLとトンネル">
            <Status value={state.tunnels.status} />
            {state.tunnels.error && (
              <Alert color="red">{state.tunnels.error}</Alert>
            )}
            <Form
              initial={state.config}
              fields={[
                { key: "engineUrl", label: "公開HTTPS URL" },
                {
                  key: "provider",
                  label: "公開方法",
                  options: ["manual", "ngrok", "cloudflare"].map((value) => ({
                    value,
                    label: value,
                  })),
                },
              ]}
              submit={(data) => action("public", data)}
            />
            <Form
              fields={[
                {
                  key: "provider",
                  label: "トンネル",
                  options: ["ngrok", "cloudflare"].map((value) => ({
                    value,
                    label: value,
                  })),
                },
                {
                  key: "token",
                  label: "トークン（変更時のみ）",
                  secret: true,
                  optional: true,
                },
                {
                  key: "engineUrl",
                  label: "公開URL（Cloudflare）",
                  optional: true,
                },
              ]}
              submit={async (data) => {
                await action("tunnels/install", { provider: data.provider });
                return action("tunnels/start", data);
              }}
              label="導入して起動"
            />
            <Group>
              <Button onClick={() => invoke("tunnels/doctor", {})}>
                トンネル診断
              </Button>
              <Button onClick={() => invoke("tunnels/stop", {})}>
                トンネル停止
              </Button>
            </Group>
          </Card>
        </>
      )}
      {state.plugins
        .filter(
          (plugin) =>
            plugin.manifest?.capabilities.includes("activity") &&
            plugin.manifest.web,
        )
        .map((plugin) => (
          <Card key={plugin.id} title={`${plugin.manifest?.title} の本人確認`}>
            <Button
              onClick={() => {
                void fetch(`${plugin.manifest!.web!.basePath}/link`, {
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
              }}
            >
              アカウントを連携
            </Button>
          </Card>
        ))}
    </Stack>
  );
}
