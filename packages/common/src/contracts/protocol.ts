import type { ExecutionPolicy, WorkReceipt, WorkSource } from "./work.js";

export const VERSION = 1;
export const RELEASE = "0.2.0";
export type Role = "admin" | "member" | "viewer";
export interface User {
  id: string;
  name: string;
  role: Role;
}
export interface ClientProfile {
  name: string;
  context: string;
  codexConnected: boolean;
}
export interface Project {
  ownerDeviceId?: string;
  isDefault?: boolean;
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
export interface Command {
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
