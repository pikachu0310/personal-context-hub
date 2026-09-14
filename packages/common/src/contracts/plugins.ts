import type { User } from "./protocol.js";
export const PLUGIN_PROTOCOL = 2;
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
    options?: Array<{ value: string; label: string }>;
    multiline?: boolean;
  }>;
  web?: {
    basePath: string;
    publicPaths: string[];
    launch?: { path: string; query: string[] };
    frameOrigins?: string[];
    frameAncestors?: string[];
  };
  capabilities: Array<"text" | "audio" | "activity" | "web">;
}

export interface ConversationInput {
  eventId: string;
  meetingId: string;
  projectId?: string;
  subject?: string;
  text?: string;
  audio?: string;
  command?: "ask" | "task" | "stop" | "steer" | "context";
  taskId?: string;
  interaction?: boolean;
  replyTo?: Record<string, unknown>;
}
export interface PluginOutput {
  kind: "reply" | "audio";
  eventId: string;
  content?: string;
  file?: string;
  audio?: string;
  replyTo?: Record<string, unknown>;
}
export interface PluginEvent {
  type: "transcript" | "minutes" | "tasks";
  meetingId: string;
  data: unknown;
}
export interface PluginRequest {
  operation: string;
  input: Record<string, unknown>;
  context?: string;
}
export type PluginFrame = {
  v: number;
  type: string;
  id?: string;
  [key: string]: unknown;
};
export interface InputContext {
  pluginId: string;
  actor: User;
  valid(): boolean;
  deliver(output: PluginOutput): Promise<void>;
  publish(event: PluginEvent): void;
}
export function pluginFrame(value: unknown): PluginFrame {
  if (
    !value ||
    typeof value !== "object" ||
    (value as PluginFrame).v !== PLUGIN_PROTOCOL ||
    typeof (value as PluginFrame).type !== "string"
  )
    throw new Error("PLUGIN_PROTOCOL_MISMATCH");
  return value as PluginFrame;
}
