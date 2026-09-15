import type {
  AccessMode,
  ExecutionPolicy,
  WorkReceipt,
  WorkSource,
} from "./work.js";

export const VERSION = 1;
export const RELEASE = "0.2.0";
export type Role = "admin" | "member" | "viewer";
export interface User {
  id: string;
  name: string;
  role: Role;
}
export interface TaskParticipant {
  id: string;
  identityId?: string;
  name: string;
  avatar?: string;
  bot?: boolean;
}
export interface RequestMessage {
  sender?: TaskParticipant;
  sentAt?: number;
}
export interface ClientProfile {
  claudeConnected?: boolean;
  taskOptionsVersion?: number;
  avatar?: string;
  name: string;
  context: string;
  codexConnected: boolean;
}
export interface Project {
  membershipVersion?: number;
  ownerDeviceId?: string;
  isDefault?: boolean;
  id: string;
  name: string;
  remote: string;
}
export interface Grant {
  agents?: Array<"codex" | "claude">;
  projectId: string;
  network: boolean;
  slots: number;
}
export interface Mapping extends Grant {
  agent?: "codex" | "claude";
  executionAllowed?: boolean;
  model?: string;
  reasoningEffort?: string;
  accessMode?: AccessMode;
  progressMode?: "auto" | "manual";
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
export interface AttachedTaskSource {
  id: string;
  title: string;
  kind: "minutes" | "context";
  text: string;
}
export interface Task {
  agent?: "codex" | "claude";
  model?: string;
  reasoningEffort?: string;
  progressMode?: "auto" | "manual";
  trigger?: "requested" | "proactive";
  initialText?: string;
  queuedInstructions?: Array<RequestMessage & { id: string; text: string }>;
  attachedSources?: AttachedTaskSource[];
  localMirror?: { deviceId: string; runId: string; sequence: number };
  // New Discord bot tasks separate execution membership from source authors.
  // Absence preserves the participant behavior of existing tasks.
  participantPolicy?: "execution";
  memberStates?: Record<string, boolean>;
  membershipVersion?: number;
  canDelete?: boolean;
  createdByBot?: boolean;
  participants?: TaskParticipant[];
  id: string;
  requestId: string;
  projectId: string;
  meetingId: string;
  authorId: string;
  text: string;
  state: TaskState;
  clientId?: string;
  assignedAt?: number;
  assignmentReason?: string;
  runId: string;
  revision: number;
  network: boolean;
  createdAt: number;
  updatedAt: number;
  result?: string;
  progress?: string;
  title?: string;
  kind?: string;
  sourceIds?: string[];
  sourceSequences?: number[];
  sourceStatements?: WorkSource[];
  executionPolicy?: ExecutionPolicy;
  effectiveExecutionPolicy?: ExecutionPolicy;
  specRevision?: number;
  resultSpecRevision?: number;
  controlVersion?: number;
  controlReceipts?: Record<string, WorkReceipt>;
  preview?: Preview;
  history: Array<{
    revision: number;
    text: string;
    result?: string;
    specRevision?: number;
    resultSpecRevision?: number;
  }>;
}
export interface Preview {
  id: string;
  taskId: string;
  runId: string;
  revision: number;
  expiresAt: number;
}
export interface Command extends RequestMessage {
  v: 1;
  type: string;
  id?: string;
  generation?: number;
  taskId?: string;
  runId?: string;
  receiptId?: string;
  controlVersion?: number;
  specRevision?: number;
  instructionResolution?: "retry" | "discard";
  [key: string]: unknown;
}
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

/** Small, inert raster data only. Shared in profile frames, never external URLs. */
export function avatar(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
  )
    throw new Error("INVALID_AVATAR");
  return value;
}

/** Attachments are bounded snapshots, not executable instructions. */
export function attachTaskSource(
  existing: AttachedTaskSource[] = [],
  input: Record<string, unknown>,
): AttachedTaskSource[] {
  const source: AttachedTaskSource = {
    id: `attachment-${id(input.sourceId)}`,
    kind: input.kind === "minutes" ? "minutes" : "context",
    title: text(input.title, 200),
    text: text(input.text, 16000),
  };
  const next = [...existing.filter((item) => item.id !== source.id), source];
  if (
    next.length > 20 ||
    next.reduce((size, item) => size + item.text.length, 0) > 64000
  )
    throw new Error("SOURCE_LIMIT_EXCEEDED");
  return next;
}
