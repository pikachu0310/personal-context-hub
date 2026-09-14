export const VERSION = 1;
export const RELEASE = "0.2.0";
export type Role = "admin" | "member" | "viewer";
export interface User {
  id: string;
  name: string;
  role: Role;
}
export interface Project {
  id: string;
  name: string;
  remote: string;
}
export interface Grant {
  projectId: string;
  network: boolean;
  slots: number;
}
export interface Mapping extends Grant {
  directory: string;
  previewCommand?: string[];
}
export type TaskState =
  | "queued"
  | "assigned"
  | "running"
  | "interrupted"
  | "completed"
  | "failed"
  | "cancelled";
export interface Task {
  id: string;
  requestId: string;
  projectId: string;
  meetingId: string;
  authorId: string;
  text: string;
  state: TaskState;
  clientId?: string;
  runId: string;
  revision: number;
  network: boolean;
  createdAt: number;
  updatedAt: number;
  result?: string;
  progress?: string;
  preview?: Preview;
  history: Array<{ revision: number; text: string; result?: string }>;
}
export interface Preview {
  id: string;
  taskId: string;
  runId: string;
  revision: number;
  expiresAt: number;
}
export interface Command {
  v: 1;
  type: string;
  id?: string;
  generation?: number;
  taskId?: string;
  runId?: string;
  [key: string]: unknown;
}
export interface PluginConfig {
  guildId: string;
  textChannelId: string;
  voiceChannelId?: string;
  appId: string;
  projectId: string;
  meetingId: string;
}
export interface PluginManifest {
  id: string;
  version: string;
  protocol: number;
  title: string;
  fields: Array<{
    key: string;
    label: string;
    secret?: boolean;
    required?: boolean;
  }>;
  capabilities: Array<"text" | "audio" | "activity">;
}
export const discordManifest: PluginManifest = {
  id: "discord",
  version: RELEASE,
  protocol: VERSION,
  title: "Discord Bot + Activity",
  fields: [
    { key: "botToken", label: "Bot token", secret: true, required: true },
    { key: "guildId", label: "Guild", required: true },
    { key: "textChannelId", label: "Text channel", required: true },
    { key: "voiceChannelId", label: "Voice channel" },
    { key: "appId", label: "Application ID", required: true },
    {
      key: "clientSecret",
      label: "OAuth client secret",
      secret: true,
      required: true,
    },
  ],
  capabilities: ["text", "audio", "activity"],
};
export function frame(data: unknown): Command {
  const value = typeof data === "string" ? JSON.parse(data) : data;
  if (
    !value ||
    typeof value !== "object" ||
    value.v !== VERSION ||
    typeof value.type !== "string"
  )
    throw new Error("PROTOCOL_MISMATCH");
  return value;
}
export function text(value: unknown, max = 16000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("INVALID_TEXT");
  return value.trim();
}
export function id(value: unknown): string {
  const result = text(value, 100);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error("INVALID_ID");
  return result;
}
export function endpoint(value: unknown): URL {
  const url = new URL(text(value, 2048));
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("INVALID_ORIGIN");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("HTTPS_REQUIRED");
  return url;
}
export function clean(value: string): string {
  return value
    .replace(
      /(?:sk-[\w-]{8,}|Bearer\s+\S+|(?:token|password|secret|api[_ -]?key)\s*[=:]\s*\S+)/gi,
      "[redacted]",
    )
    .slice(0, 16000);
}
