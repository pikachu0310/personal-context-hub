import type {
  ClientActivityState,
  ClientState,
  TaskEnvironment,
} from "./api.js";
import type { Task } from "./protocol.js";

/** Explicit display projection. Credentials and execution handles are never included. */
export interface TaskDetailSnapshot {
  version: 1;
  taskId: string;
  runId: string;
  revision: number;
  sequence: number;
  capturedAt: number;
  run: ClientState["runs"][number];
  activity: ClientActivityState;
  plan?: string;
  approvals: ClientState["approvals"];
  environment?: TaskEnvironment;
  environmentAt?: number;
  environmentError?: string;
  patch?: string;
  patchAt?: number;
  patchError?: string;
}
export interface TaskDetailRead {
  task: Task;
  snapshot?: TaskDetailSnapshot;
  syncedAt?: number;
  ownerConnected: boolean;
  supported: boolean;
}
export interface TaskDetailPage {
  token: string;
  data: string;
  nextOffset?: number;
}
export function taskProgress(
  progress: string | undefined,
  state: string,
): string {
  if (
    progress &&
    !/^(?:turn|thread|item)\.[a-z_.]+$/.test(progress) &&
    progress !== "error"
  )
    return progress;
  return (
    (
      {
        completed: "完了",
        running: "実行中",
        assigned: "開始待ち",
        queued: "待機中",
        interrupted: "中断",
        failed: "失敗",
        cancelled: "停止済み",
      } as Record<string, string>
    )[state] ?? "状態を確認中"
  );
}

export function activityText(value: unknown, limit = 16_000): string {
  if (typeof value !== "string") return "";
  return value
    .slice(0, Math.max(limit * 2, 65536))
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(
      /-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g,
      "[credential hidden]",
    )
    .replace(
      /\b(?:sk-(?:proj-|svcacct-)?[\w-]{20,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,})/g,
      "[credential hidden]",
    )
    .replace(/\b[MN][\w-]{23,}\.[\w-]{6}\.[\w-]{27,}/g, "[credential hidden]")
    .replace(/\bBearer\s+[\w.+/=-]+/gi, "Bearer [hidden]")
    .replace(
      /\b((?:[\w-]{0,80}(?:token|secret|password|api[_-]?key))["']?\s*[:=]\s*)["']?[^\s,"'}]+["']?/gi,
      "$1[hidden]",
    )
    .slice(0, limit);
}

const taskFields = [
  "id",
  "runId",
  "requestId",
  "revision",
  "projectId",
  "meetingId",
  "authorId",
  "text",
  "initialText",
  "title",
  "state",
  "clientId",
  "createdAt",
  "updatedAt",
  "network",
  "history",
  "participants",
  "createdByBot",
  "kind",
  "sourceIds",
  "sourceStatements",
  "sourceSequences",
  "queuedInstructions",
  "attachedSources",
  "specRevision",
  "resultSpecRevision",
  "result",
  "progress",
  "executionPolicy",
  "effectiveExecutionPolicy",
  "participantPolicy",
  "memberStates",
  "membershipVersion",
] as const;
export function detailTask(task: Task): Task {
  return Object.fromEntries(
    taskFields.filter((k) => task[k] !== undefined).map((k) => [k, task[k]]),
  ) as unknown as Task;
}
// Preserve the display limits while masking credentials in every text-bearing field.
export function sanitizeDetail<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, value) => {
      if (typeof value !== "string") return value;
      if (
        /^(?:token|secret|password|api[_-]?key|authorization|cookie)$/i.test(
          key,
        )
      )
        return "[credential hidden]";
      return activityText(value, Math.max(16000, value.length));
    }),
  );
}

// Validate the network shape before any renderer sees it, then retain only display fields.
export function parseTaskDetail(input: unknown): TaskDetailSnapshot {
  const fail = (): never => {
    throw new Error("INVALID_DETAIL");
  };
  const obj = (v: unknown): Record<string, any> =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, any>)
      : fail();
  const fields = (v: unknown, strings: string[], numbers: string[] = []) => {
    const x = obj(v);
    for (const k of strings)
      if (x[k] !== undefined && typeof x[k] !== "string") fail();
    for (const k of numbers)
      if (
        x[k] !== undefined &&
        (typeof x[k] !== "number" || !Number.isFinite(x[k]))
      )
        fail();
    return x;
  };
  const list = (v: unknown, max: number, check: (v: unknown) => unknown) => {
    if (!Array.isArray(v) || v.length > max) return fail();
    return v.map(check);
  };
  const participant = (v: unknown) => {
    const x = fields(v, ["id", "identityId", "name", "avatar"], []);
    if (typeof x.id !== "string" || typeof x.name !== "string") fail();
    return x;
  };
  const value = fields(
    input,
    ["taskId", "runId", "plan", "patch", "patchError", "environmentError"],
    ["revision", "sequence", "capturedAt", "patchAt", "environmentAt"],
  );
  if (
    value.version !== 1 ||
    typeof value.taskId !== "string" ||
    typeof value.runId !== "string" ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    !Number.isFinite(value.capturedAt)
  )
    fail();
  const r = fields(
    value.run,
    [
      "directory",
      "state",
      "result",
      "progress",
      "agent",
      "model",
      "reasoningEffort",
      "origin",
      "accessMode",
      "progressMode",
      "pendingProgressMode",
      "phase",
    ],
    ["activityVersion", "updatedAt"],
  );
  if (typeof r.directory !== "string" || typeof r.state !== "string") fail();
  const t = fields(
    r.task,
    [
      "id",
      "runId",
      "requestId",
      "projectId",
      "meetingId",
      "authorId",
      "text",
      "initialText",
      "title",
      "state",
      "clientId",
      "kind",
      "result",
      "progress",
    ],
    ["revision", "createdAt", "updatedAt"],
  );
  if (typeof t.text !== "string" || typeof t.projectId !== "string") fail();
  list(t.history, 10000, (h) =>
    fields(
      h,
      ["text", "result"],
      ["revision", "specRevision", "resultSpecRevision"],
    ),
  );
  if (t.participants !== undefined) list(t.participants, 1000, participant);
  if (t.queuedInstructions !== undefined)
    list(t.queuedInstructions, 1000, (i) => {
      const x = fields(i, ["id", "text"], ["sentAt"]);
      if (x.sender) participant(x.sender);
      return x;
    });
  if (t.sourceIds !== undefined)
    list(t.sourceIds, 10000, (x) => (typeof x === "string" ? x : fail()));
  if (r.contextSources !== undefined)
    list(r.contextSources, 10000, (v) => {
      const x = fields(v, ["id", "kind", "title", "text", "detail"]);
      if (typeof x.text !== "string" || typeof x.title !== "string") fail();
      return x;
    });
  const a = fields(value.activity, [], ["dropped", "version"]);
  const entries = list(a.entries, 300, (v) => {
    const x = fields(
      v,
      ["id", "kind", "title", "status", "text", "output", "event"],
      ["revision", "at", "updatedAt", "sentAt", "requestAt", "exitCode"],
    );
    if (
      ![
        "message",
        "command",
        "files",
        "tool",
        "status",
        "instruction",
      ].includes(x.kind) ||
      typeof x.id !== "string" ||
      typeof x.title !== "string" ||
      !Number.isFinite(x.at)
    )
      fail();
    if (x.sender !== undefined) participant(x.sender);
    if (x.files !== undefined)
      list(x.files, 100, (f) => fields(f, ["path", "kind"]));
    return x;
  });
  const approvals = list(value.approvals, 100, (v) => {
    const x = fields(v, ["id", "runId", "method"]);
    if (typeof x.id !== "string" || typeof x.method !== "string") fail();
    return { id: x.id, runId: x.runId, method: x.method, params: x.params };
  });
  if (value.environment !== undefined)
    fields(value.environment, [
      "directory",
      "branch",
      "commit",
      "deviceName",
      "ownerName",
    ]);
  const pick = (x: Record<string, any>, keys: string[]) =>
    Object.fromEntries(
      keys.filter((k) => x[k] !== undefined).map((k) => [k, x[k]]),
    );
  return sanitizeDetail({
    ...pick(value, [
      "version",
      "taskId",
      "runId",
      "revision",
      "sequence",
      "capturedAt",
      "plan",
      "environmentAt",
      "environmentError",
      "patch",
      "patchAt",
      "patchError",
    ]),
    environment: value.environment
      ? pick(value.environment, [
          "directory",
          "branch",
          "commit",
          "deviceName",
          "ownerName",
        ])
      : undefined,
    run: {
      ...pick(r, [
        "directory",
        "state",
        "result",
        "progress",
        "agent",
        "model",
        "reasoningEffort",
        "origin",
        "accessMode",
        "progressMode",
        "pendingProgressMode",
        "phase",
        "contextSources",
        "activityVersion",
        "updatedAt",
        "discordShare",
      ]),
      task: detailTask(t as Task),
    },
    activity: {
      entries: entries.map((x) =>
        pick(obj(x), [
          "id",
          "revision",
          "at",
          "updatedAt",
          "kind",
          "sender",
          "sentAt",
          "event",
          "requestAt",
          "title",
          "status",
          "text",
          "output",
          "exitCode",
          "files",
          "truncated",
        ]),
      ),
      dropped: a.dropped ?? 0,
      version: a.version ?? 0,
    },
    approvals,
  } as TaskDetailSnapshot);
}
