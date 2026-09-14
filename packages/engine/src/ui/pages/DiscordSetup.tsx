import {
  Alert,
  Button,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useState } from "react";
import { Form, type Action, type PluginState } from "@ido/common-ui";
const errors: Record<string, string> = {
  DISCORD_TOKEN_REQUIRED: "Botトークンを入力してください。",
  DISCORD_TOKEN_INVALID: "Botトークンを確認してください。",
  DISCORD_GUILD_REQUIRED: "Guild IDを入力してください。",
  DISCORD_GUILD_ACCESS_REQUIRED:
    "対象サーバーにBotを招待し、Guild IDを確認してください。",
  DISCORD_CHANNEL_PERMISSION_REQUIRED:
    "選択したチャンネルの閲覧・送信・履歴の閲覧・ファイル添付をBotに許可してください。",
};
export function DiscordSetup({
  plugin,
  action,
}: {
  plugin: PluginState;
  action: Action;
}) {
  const [token, setToken] = useState("");
  const [guild, setGuild] = useState(plugin.config.guildId ?? "");
  const [channel, setChannel] = useState(plugin.config.textChannelId ?? "");
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  const [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const basic = { guildId: guild, ...(token ? { botToken: token } : {}) };
  const inspect = async (selected = "") => {
    const result = (await action("plugins/setup", {
      pluginId: plugin.id,
      config: { ...basic, textChannelId: selected },
    })) as unknown as {
      appId: string;
      channels: Array<{ id: string; name: string }>;
    };
    setChannels(result.channels);
    setChecked(true);
    return result;
  };
  return (
    <Stack>
      <PasswordInput
        label="Botトークン"
        autoComplete="off"
        placeholder={
          plugin.secrets?.botToken
            ? "保存済み（変更する場合のみ入力）"
            : "Botトークンを入力"
        }
        value={token}
        onChange={(e) => {
          setToken(e.currentTarget.value);
          setChecked(false);
        }}
      />
      <TextInput
        label="Guild ID"
        value={guild}
        onChange={(e) => {
          setGuild(e.currentTarget.value);
          setChecked(false);
        }}
      />
      <Button
        variant="light"
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await inspect();
          } catch (e) {
            setError(errors[(e as Error).message] ?? (e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        接続を確認してチャンネルを取得
      </Button>
      <Select
        label="デフォルトチャンネル"
        searchable
        disabled={!checked}
        value={channel}
        data={channels.map((c) => ({ value: c.id, label: `#${c.name}` }))}
        onChange={(v) => setChannel(v ?? "")}
      />
      <Text size="sm" c="dimmed">
        Application
        IDは自動取得します。会話はデフォルトプロジェクトで始まり、Discordの
        /project で切り替えられます。
      </Text>
      <Button
        loading={busy}
        disabled={!checked || !channel}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const setup = await inspect(channel);
            await action("plugins/configure", {
              pluginId: plugin.id,
              config: { ...basic, textChannelId: channel, appId: setup.appId },
            });
            if (plugin.status !== "running")
              await action("plugins/start", { pluginId: plugin.id });
            setToken("");
          } catch (e) {
            setError(errors[(e as Error).message] ?? (e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        保存して起動
      </Button>
      {error && <Alert color="red">{error}</Alert>}
      <details>
        <summary>詳細設定（任意）</summary>
        <Form
          initial={Object.fromEntries(
            Object.entries(plugin.config).filter(
              ([key]) =>
                ![
                  "botToken",
                  "guildId",
                  "textChannelId",
                  "appId",
                  "projectId",
                  "meetingId",
                  "projectRevision",
                ].includes(key),
            ),
          )}
          fields={(plugin.manifest?.fields ?? [])
            .filter(
              (f) =>
                !["botToken", "guildId", "textChannelId", "appId"].includes(
                  f.key,
                ),
            )
            .map((f) => ({
              ...f,
              optional: true,
              configured: plugin.secrets?.[f.key],
            }))}
          submit={(config) =>
            action("plugins/configure", { pluginId: plugin.id, config })
          }
          label="詳細設定を保存"
        />
      </details>
    </Stack>
  );
}
