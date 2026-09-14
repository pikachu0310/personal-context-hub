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
/** Local Client activity. Never part of Engine result frames or forum updates. */
export interface ClientActivity {
  id: string;
  revision: number;
  at: number;
  updatedAt: number;
  kind: "message" | "command" | "files" | "tool" | "status" | "instruction";
  title: string;
  status?: string;
  text?: string;
  output?: string;
  exitCode?: number;
  files?: Array<{ path: string; kind: string }>;
  truncated?: boolean;
}
export interface ClientActivityState {
  entries: ClientActivity[];
  dropped: number;
  version: number;
}
export interface ClientState {
  controlSupported?: boolean;
  csrf: string;
  settings: {
    progressMode?: "auto" | "manual";
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
    activityVersion?: number;
    progressMode?: "auto" | "manual";
    phase?: "planning" | "awaiting-plan" | "executing";
    updatedAt?: number;
  }>;
  approvals: Array<{
    id: string;
    runId?: string;
    method: string;
    params: unknown;
  }>;
}
export interface ApiResult {
  url?: string;
  error?: string;
  patch?: string;
  csrf?: string;
}
