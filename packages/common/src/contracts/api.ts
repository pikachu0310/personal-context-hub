import type { MinutesMetadata } from "./minutes.js";
import type { AccessMode } from "./work.js";
export {
  detailTask,
  sanitizeDetail,
  parseTaskDetail,
  activityText,
  taskProgress,
} from "./task-detail.js";
export type {
  TaskDetailSnapshot,
  TaskDetailPage,
  TaskDetailRead,
} from "./task-detail.js";
export {
  taskUrl,
  parseTaskUrl,
  taskMarkdown,
  MAX_MINUTES_LENGTH,
} from "./minutes.js";
export type {
  TaskReference,
  MinutesMetadata,
  MinutesUpdateInput,
} from "./minutes.js";
import type { PluginManifest } from "./plugins.js";
import type {
  Grant,
  Mapping,
  Project,
  Task,
  User,
  RequestMessage,
} from "./protocol.js";
export interface MessageView {
  id: string;
  authorId: string;
  authorName?: string;
  authorIdentityId?: string;
  role?: "user" | "assistant";
  text: string;
  replyText?: string;
  at: number;
  stage: string;
  steps?: Record<string, { state: string; errorId?: string }>;
}
export interface MeetingView extends MinutesMetadata {
  messageCount?: number;
  lastMessageAt?: number;
  knowledge?: import("./knowledge.js").MeetingKnowledge;
  startedAt?: number;
  closedAt?: number;
  id: string;
  name: string;
  projectId?: string;
  summary: string;
  messages: MessageView[];
}
export interface ConversationBinding {
  pluginId: string;
  title: string;
  projectId: string;
  projectName: string;
}
export interface WorkspaceState {
  conversationBindings?: ConversationBinding[];
  deletionSync?: { pendingClients: number };
  user: User;
  projects: Project[];
  conversations?: Array<{
    projectId: string;
    meetingId: string;
    lastHumanAt?: number;
  }>;
  meetings: MeetingView[];
  tasks: Task[];
}
export interface ProjectWorkspace {
  transcriptPaging?: boolean;
  canEditMinutes?: boolean;
  project: Project;
  minutes: MeetingView[];
  tasks: Task[];
  participants: Array<{
    id: string;
    identityId?: string;
    name: string;
    context: string;
    avatar?: string;
    codexConnected: boolean;
  }>;
}
export interface TranscriptQuery {
  query?: string;
  meetingId?: string;
  topicId?: string;
  before?: { at: number; id: string };
}
export interface TranscriptPage {
  messages: Array<MessageView & { meetingId: string; meetingName: string }>;
  total: number;
  next?: { at: number; id: string };
}
export interface PluginState {
  id: string;
  manifest?: PluginManifest;
  installed?: { version: string; builtin?: boolean };
  version?: string;
  secrets?: Record<string, boolean>;
  status: string;
  busy: boolean;
  config: Record<string, string>;
}
export interface AdminState {
  user: User;
  csrf: string;
  pendingClients?: Array<{ id: string; name: string; expires: number }>;
  clients: Array<{
    codexConnected?: boolean;
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
    reasoningEffort?: string;
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
  secrets: { openai?: boolean; tunnels?: Record<string, boolean> };
  credentialStorage?: { backend: string; path: string };
  config: Record<string, string>;
  tunnels: { status: string; busy: boolean; error?: string };
}
/** Activity shared through the authenticated detail channel, never result/forum frames. */
export interface ClientActivity extends RequestMessage {
  event?: "started";
  requestAt?: number;
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
export interface ClientAccount {
  status: "available" | "signed-out" | "unavailable";
  type?: string;
  email?: string;
}
/** Context supplied to the agent; shared in task details, never in team summaries. */
export interface TaskContextSource {
  id: string;
  title: string;
  kind: "minutes" | "profile" | "context";
  text: string;
  detail?: string;
}
export interface TaskEnvironment {
  directory: string;
  branch?: string;
  commit?: string;
  deviceName: string;
  ownerName?: string;
}
export interface ClientState {
  taskDetailSupported?: boolean;
  lifecycleSupported?: boolean;
  deletionSync?: { pendingTasks: number };
  account?: ClientAccount;
  identity?: { status: string; directory: string };
  allowedProjectIds?: string[];
  projectTasks?: Task[];
  projectCreationSupported?: boolean;
  teamTasksSupported?: boolean;
  teamTasks?: TeamTaskSnapshot;
  controlSupported?: boolean;
  continuationSupported?: boolean;
  csrf: string;
  suggestedInvite?: { engineUrl: string; token: string };
  settings: {
    profile?: { name: string; context: string; avatar?: string };
    accessMode?: AccessMode;
    progressMode?: "auto" | "manual";
    pendingProgressMode?: "auto" | "manual";
    slots: number;
    deviceId?: string;
    identityId?: string;
    engineUrl?: string;
    projects: Project[];
    mappings: Mapping[];
  };
  connected: boolean;
  status: string;
  allow: boolean;
  loginStatus: string;
  claudeLoginStatus?: string;
  claudeLoginUrl?: string;
  loginUrl?: string;
  suggestedEngine?: string;
  desktop?: { name: string; version: string; pid: number; platform: string };
  pairing?: { url: string; fingerprint: string };
  runs: Array<{
    contextSources?: TaskContextSource[];
    agent?: "codex" | "claude";
    model?: string;
    reasoningEffort?: string;
    origin?: "local";
    discordShare?: {
      projectId: string;
      taskId?: string;
      status?: "pending" | "synced" | "error";
      error?: string;
    };
    task: Task;
    directory: string;
    state: string;
    result?: string;
    progress?: string;
    activityVersion?: number;
    accessMode?: AccessMode;
    progressMode?: "auto" | "manual";
    pendingProgressMode?: "auto" | "manual";
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
/** Shared summaries only: no local paths, command output or approval data. */
export interface TeamTaskSnapshot {
  profiles?: import("./protocol.js").TaskParticipant[];
  updatedAt: number;
  total: number;
  tasks: Array<
    Pick<
      Task,
      | "priority"
      | "id"
      | "runId"
      | "revision"
      | "projectId"
      | "title"
      | "state"
      | "clientId"
      | "updatedAt"
    > & {
      participants?: import("./protocol.js").TaskParticipant[];
      ownerName?: string;
      clientIdentityId?: string;
      deviceName?: string;
      deviceConnected?: boolean;
      progress?: string;
    }
  >;
}
export interface AgentCatalogEntry {
  agent: "codex" | "claude";
  authenticated: boolean;
  models: Array<{
    id: string;
    name: string;
    supportedEfforts?: string[];
    defaultEffort?: string;
  }>;
  error?: string;
}
export interface ApiResult {
  agents?: AgentCatalogEntry[];
  runId?: string;
  url?: string;
  error?: string;
  patch?: string;
  csrf?: string;
}

/** Administration projection: no credentials, local paths or raw worker output. */
export interface DashboardTask {
  membershipVersion?: number;
  id: string;
  runId: string;
  revision: number;
  controlVersion: number;
  projectId: string;
  meetingId: string;
  title: string;
  state: Task["state"];
  clientId?: string;
  userId?: string;
  createdAt: number;
  updatedAt: number;
  assignedAt?: number;
  assignmentReason?: string;
  waitReason?: string;
  stop?: { delivery: string };
}
export interface DashboardConnection {
  id: string;
  name: string;
  userId: string;
  generation: number;
  connected: boolean;
  ready: boolean;
  disconnecting: boolean;
  connectedAt?: number;
  lastSeenAt?: number;
  slots: number;
  projectIds: string[];
}
export interface DashboardState {
  conversationBindings?: ConversationBinding[];
  deletionSync?: { pendingClients: number };
  user: User;
  updatedAt: number;
  projects: Array<{
    isDefault?: boolean;
    membershipVersion?: number;
    id: string;
    name: string;
    userIds: string[];
    connectedUserIds: string[];
    running: number;
    waiting: number;
    lastActivityAt?: number;
  }>;
  users: User[];
  connections: DashboardConnection[];
  tasks: DashboardTask[];
  meetings: Array<{
    id: string;
    projectId?: string;
    name: string;
    startedAt?: number;
    closedAt?: number;
  }>;
  counts: {
    running: number;
    waiting: number;
    connectedUsers: number;
    activeConversations: number;
    projects: number;
  };
  activity: {
    from: number;
    to: number;
    observedFrom: number;
    total: number;
    buckets: Array<{ at: number; count: number }>;
  };
}
export interface DashboardRawPage {
  items: Array<{
    id: string;
    at: number;
    projectId?: string;
    targetId: string;
    text: string;
  }>;
  total: number;
  offset: number;
  limit: number;
}
