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
  capabilities: Array<
    "text" | "audio" | "activity" | "web" | "audio-stream" | "playback-control"
  >;
}

export type ConversationModeKind = "text-speech" | "live";
export interface AudioCapture {
  sessionId: string;
  utteranceId: string;
  segmentIndex: number;
  startedAt: number;
  endedAt?: number;
  final?: boolean;
  complete?: boolean;
}
export interface AudioFrame {
  pcm: string;
  sampleRate: 48000;
  channels: 2;
  format: "pcm16";
  sequence: number;
}
export interface ConversationInput {
  eventId: string;
  meetingId: string;
  projectId?: string;
  subject?: string;
  text?: string;
  audio?: string;
  audioFrame?: AudioFrame;
  activity?: "start" | "end" | "quiet";
  capture?: AudioCapture;
  conversationMode?: ConversationModeKind;
  priority?: "normal" | "immediate";
  command?: "ask" | "task" | "stop" | "steer" | "context" | "mode";
  taskId?: string;
  interaction?: boolean;
  replyTo?: Record<string, unknown>;
}
export interface PluginOutput {
  kind: "reply" | "audio" | "audio-frame" | "audio-stop";
  eventId: string;
  content?: string;
  file?: string;
  audio?: string;
  audioFormat?: "ogg-opus" | "pcm16-24000-mono";
  candidateId?: string;
  audioSequence?: number;
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
