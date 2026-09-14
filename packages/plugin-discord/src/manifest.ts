import {
  PLUGIN_PROTOCOL,
  type PluginManifest,
} from "@ido/common/contracts/plugins";
import { RELEASE } from "@ido/common/contracts/protocol";
export interface PluginConfig {
  guildId: string;
  textChannelId: string;
  appId: string;
  projectId: string;
  meetingId: string;
}
export const discordManifest: PluginManifest = {
  id: "discord",
  version: RELEASE,
  protocol: PLUGIN_PROTOCOL,
  title: "Discord Bot + Activity",
  fields: [
    {
      key: "userPolicy",
      label: "発言・タスク操作を受け付けるユーザー",
      options: [
        { value: "all", label: "全員を許可" },
        { value: "allowlist", label: "指定したユーザーIDだけ許可" },
      ],
    },
    {
      key: "allowedUserIds",
      label: "許可するDiscordユーザーID",
      multiline: true,
    },
    {
      key: "botToken",
      label: "Botトークン（変更時のみ）",
      secret: true,
      required: true,
    },
    { key: "guildId", label: "Guild ID", required: true },
    {
      key: "voiceChannelId",
      label: "起動時に参加する通話チャンネルID（任意）",
    },
    {
      key: "messageContentIntent",
      label: "通常のテキスト発言を受信する",
      options: [
        { value: "true", label: "有効（Discord側の許可が必要）" },
        { value: "false", label: "無効（通話とコマンドは利用可能）" },
      ],
    },
    {
      key: "issueForumChannelId",
      label: "タスク進捗を共有するフォーラム／テキストチャンネルID（任意）",
    },
    {
      key: "windowsDownloadUrl",
      label: "WindowsインストーラーのHTTPSダウンロードURL",
    },
    {
      key: "macArmDownloadUrl",
      label: "Mac Apple Silicon版のHTTPSダウンロードURL",
    },
    { key: "macIntelDownloadUrl", label: "Mac Intel版のHTTPSダウンロードURL" },
    { key: "textChannelId", label: "デフォルトチャンネルID", required: true },
    { key: "appId", label: "Application ID（自動取得）" },
    {
      key: "clientSecret",
      label: "OAuthクライアントシークレット（変更時のみ）",
      secret: true,
    },
  ],
  web: {
    basePath: "/plugins/discord",
    launch: { path: "/activity", query: ["frame_id"] },
    frameAncestors: [
      "https://discord.com",
      "https://*.discord.com",
      "https://*.discordsays.com",
    ],
    publicPaths: [
      "/connect",
      "/callback",
      "/activity",
      "/assets/",
      "/api/activity/config",
      "/api/activity/auth",
      "/api/activity/state",
      "/api/activity/message",
      "/api/activity/control",
      "/api/activity/preview",
    ],
  },
  capabilities: [
    "task-forum",
    "project-conversation",
    "text",
    "audio",
    "activity",
    "audio-stream",
    "playback-control",
  ],
};
