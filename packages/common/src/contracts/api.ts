import type { PluginManifest } from "./plugins.js";
import type { Grant, Mapping, Project, Task, User } from "./protocol.js";
export interface MessageView {
  id: string;
  authorId: string;
  authorName?: string;
  role?: "user" | "assistant";
  text: string;
  replyText?: string;
  at: number;
  stage: string;
  steps?: Record<string, { state: string; errorId?: string }>;
}
export interface MeetingView {
  id: string;
  name: string;
  projectId?: string;
  summary: string;
  messages: MessageView[];
}
export interface WorkspaceState {
  user: User;
  projects: Project[];
  meetings: MeetingView[];
  tasks: Task[];
}
export interface PluginState {
  id: string;
  manifest?: PluginManifest;
  installed?: { version: string };
  status: string;
  busy: boolean;
  config: Record<string, string>;
}
export interface AdminState {
  user: User;
  csrf: string;
  clients: Array<{
    id: string;
    name: string;
    userId: string;
    connected: boolean;
    revoked: boolean;
    slots: number;
    grants: Grant[];
    generation: number;
  }>;
  plugins: PluginState[];
  users: User[];
  audit: Array<{ at: number; action: string; target: string }>;
  diagnostics: Array<{
    id: string;
    at: number;
    level: string;
    source: string;
    operation: string;
    eventId?: string;
    meetingId?: string;
    messageId?: string;
    model?: string;
    error: {
      reason: string;
      type: string;
      code?: string;
      status?: number;
      cause?: string;
      parameter?: string;
      requestId?: string;
    };
  }>;
  secrets: { openai?: boolean };
  config: Record<string, string>;
  tunnels: { status: string; busy: boolean; error?: string };
}
export interface ClientState {
  csrf: string;
  settings: {
    slots: number;
    deviceId?: string;
    engineUrl?: string;
    projects: Project[];
    mappings: Mapping[];
  };
  connected: boolean;
  status: string;
  allow: boolean;
  loginStatus: string;
  loginUrl?: string;
  suggestedEngine?: string;
  desktop?: { name: string; version: string; pid: number; platform: string };
  pairing?: { url: string; fingerprint: string };
  runs: Array<{
    task: Task;
    directory: string;
    state: string;
    result?: string;
    progress?: string;
  }>;
  approvals: Array<{ id: string; method: string; params: unknown }>;
}
export interface ApiResult {
  url?: string;
  error?: string;
  patch?: string;
  csrf?: string;
}
