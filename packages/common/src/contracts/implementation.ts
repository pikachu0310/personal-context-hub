/** Shared references contain Git identity only; execution handles stay on the Client. */
export interface Implementation {
  id: string;
  projectId: string;
  taskId: string;
  runId: string;
  revision: number;
  title: string;
  remote: string;
  branch: string;
  commit: string;
  createdAt: number;
}
export type ImplementationAvailability =
  "ready" | "uncommitted" | "unpushed" | "unavailable";
export interface ImplementationChoice {
  taskId: string;
  title: string;
  availability: ImplementationAvailability;
  implementation?: Implementation;
}
export interface PreviewReference {
  projectId: string;
  implementationIds: string[];
}
const identifier = /^[a-zA-Z0-9_-]{1,100}$/;
export function parseImplementation(input: unknown): Implementation {
  const value = input as Implementation | undefined;
  if (
    !value ||
    [value.id, value.projectId, value.taskId, value.runId].some(
      (id) => typeof id !== "string" || !identifier.test(id),
    ) ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    typeof value.title !== "string" ||
    value.title.length > 1000 ||
    typeof value.commit !== "string" ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.commit) ||
    typeof value.branch !== "string" ||
    value.branch.length > 300 ||
    !/^refs\/(heads|tags)\//.test(value.branch) ||
    /[\s~^:?*\[\\]|\.\.|@\{/.test(value.branch) ||
    !Number.isFinite(value.createdAt)
  )
    throw new Error("INVALID_IMPLEMENTATION");
  return {
    id: value.id,
    projectId: value.projectId,
    taskId: value.taskId,
    runId: value.runId,
    revision: value.revision,
    title: value.title,
    commit: value.commit,
    branch: value.branch,
    remote: implementationRemote(value.remote),
    createdAt: value.createdAt,
  };
}
export function previewReference(value: unknown): PreviewReference {
  const v = value as PreviewReference | undefined;
  if (
    !v ||
    typeof v.projectId !== "string" ||
    !identifier.test(v.projectId) ||
    !Array.isArray(v.implementationIds) ||
    v.implementationIds.length < 1 ||
    v.implementationIds.length > 2 ||
    v.implementationIds.some(
      (id) => typeof id !== "string" || !identifier.test(id),
    ) ||
    new Set(v.implementationIds).size !== v.implementationIds.length
  )
    throw new Error("INVALID_PREVIEW_REFERENCE");
  return {
    projectId: v.projectId,
    implementationIds: [...v.implementationIds],
  };
}
export function previewUrl(input: PreviewReference): string {
  const { projectId, implementationIds } = previewReference(input);
  return `ido://projects/${projectId}/${implementationIds.length === 1 ? "previews" : "compare"}/${implementationIds.join("/")}`;
}
export function parsePreviewUrl(value: string): PreviewReference | undefined {
  const match =
    /^ido:\/\/projects\/([\w-]{1,100})\/(previews|compare)\/([\w-]{1,100})(?:\/([\w-]{1,100}))?$/.exec(
      value,
    );
  if (!match || (match[2] === "compare") !== !!match[4]) return;
  try {
    return previewReference({
      projectId: match[1],
      implementationIds: match.slice(3).filter(Boolean),
    });
  } catch {
    return;
  }
}
export function previewMarkdown(
  reference: PreviewReference,
  label?: string,
): string {
  const text = (
    label ||
    (reference.implementationIds.length === 2 ? "2案を比較" : "実装を起動")
  )
    .replace(/[\r\n]+/g, " ")
    .replace(/[\\`*_[\]<>]/g, "\\$&");
  return `[${text}](${previewUrl(reference)})`;
}
/** Accept credential-free HTTPS or SSH Git remotes, never paths or helper protocols. */
export function implementationRemote(input: unknown): string {
  if (
    typeof input !== "string" ||
    input.length > 2000 ||
    /[\s\x00-\x1f\\]/.test(input)
  )
    throw new Error("INVALID_IMPLEMENTATION_REMOTE");
  const value = /^[\w.-]+@[\w.-]+:[^/]/.test(input)
    ? `ssh://${input.replace(":", "/")}`
    : input;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("INVALID_IMPLEMENTATION_REMOTE");
  }
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol === "https:" && url.username) ||
    !url.hostname ||
    url.pathname === "/" ||
    /(?:^|\/)\.\.(?:\/|$)/.test(input)
  )
    throw new Error("INVALID_IMPLEMENTATION_REMOTE");
  return url.href;
}
export function previewPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > 2000 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\x00-\x20]/.test(value) ||
    /%5c|%0[ad]/i.test(value)
  )
    throw new Error("INVALID_PREVIEW_PATH");
  const url = new URL(value, "http://127.0.0.1");
  if (url.origin !== "http://127.0.0.1")
    throw new Error("INVALID_PREVIEW_PATH");
  return url.pathname + url.search + url.hash;
}
export interface PreviewCapture {
  at: number;
  commit: string;
  path: string;
  width: number;
  height: number;
  url: string;
}
export interface LocalPreview {
  id: string;
  implementation: Implementation;
  state:
    | "preparing"
    | "prepared"
    | "starting"
    | "running"
    | "stopping"
    | "stopped"
    | "failed";
  directory?: string;
  url?: string;
  error?: string;
  log: string;
  capture?: PreviewCapture;
  captureError?: string;
  frameBlocked?: boolean;
  frameBlockedPath?: string;
}
