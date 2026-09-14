import { Alert, Button, Select, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import {
  Form,
  SecretInput,
  type Action,
  type PluginState,
} from "@ido/common-ui";
// Installer distribution is managed by developers, outside the admin form.
const downloadUrlFields = new Set([
  "windowsDownloadUrl",
  "macArmDownloadUrl",
  "macIntelDownloadUrl",
]);
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
  const [editingToken, setEditingToken] = useState(false);
  const [saved, setSaved] = useState(false);
  const [guild, setGuild] = useState(plugin.config.guildId ?? "");
  const [channel, setChannel] = useState(plugin.config.textChannelId ?? "");
  const [channels, setChannels] = useState<Array<{ id: string; name: string }>>(
    [],
  );
  const [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const basic = { guildId: guild, ...(token ? { botToken: token } : {}) };
  const channelOptions = channels.map((c) => ({
    value: c.id,
    label: `#${c.name}`,
  }));
  // The channel list is fetched on demand; keep the persisted selection visible
  // even before fetching options again after navigating back to this page.
  if (channel && !channelOptions.some((option) => option.value === channel))
    channelOptions.push({ value: channel, label: `${channel}（保存済み）` });
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
      <SecretInput
        label="Botトークン"
        configured={plugin.secrets?.botToken}
        editing={editingToken}
        value={token}
        busy={busy}
        onChange={(value) => {
          setToken(value);
          setChecked(false);
          setSaved(false);
        }}
        onToggleEdit={() => {
          setToken("");
          setEditingToken(!editingToken);
          setChecked(false);
          setSaved(false);
        }}
      />
      <TextInput
        label="Guild ID"
        value={guild}
        onChange={(e) => {
          setGuild(e.currentTarget.value);
          setChannel("");
          setChannels([]);
          setChecked(false);
          setSaved(false);
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
        readOnly={!checked}
        value={channel}
        data={channelOptions}
        onChange={(v) => {
          setChannel(v ?? "");
          setSaved(false);
        }}
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
            setToken("");
            setEditingToken(false);
            setSaved(true);
            if (plugin.status !== "running")
              await action("plugins/start", { pluginId: plugin.id });
          } catch (e) {
            setError(errors[(e as Error).message] ?? (e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        保存して起動
      </Button>
      {saved && (
        <Text size="sm" c="teal" role="status">
          設定を保存しました。
        </Text>
      )}
      {error && <Alert color="red">{error}</Alert>}
      <details>
        <summary>詳細設定（任意）</summary>
        <Form
          initial={Object.fromEntries(
            Object.entries(plugin.config).filter(
              ([key]) =>
                !downloadUrlFields.has(key) &&
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
                !downloadUrlFields.has(f.key) &&
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
