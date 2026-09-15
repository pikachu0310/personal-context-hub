import { id, type Task } from "@ido/common/contracts/protocol";
import type { Repository } from "../../ports/repository.js";

interface Post {
  authorKind?: "human" | "agent";
  authorName?: string;
  external?: boolean;
  id: number;
  authorTaskId: string;
  createdAt: number;
  body: string;
  replyTo?: number;
  requestKey: string;
}
export interface BoardThread {
  taskId: string;
  projectId: string;
  meetingId: string;
  sequence: number;
  posts: Post[];
}
const finished = (task: Task) =>
  ["completed", "failed", "cancelled"].includes(task.state);
export function projectDiscussion(projectId: string): Task {
  const id = `discussion-${projectId}`;
  return {
    id,
    projectId,
    runId: id,
    requestId: id,
    meetingId: id,
    authorId: "project",
    text: "相談・共有",
    title: "相談・共有",
    state: "running",
    revision: 1,
    network: false,
    createdAt: 0,
    updatedAt: 0,
    history: [],
  };
}
// Only caller-fixable validation messages may cross the Client boundary.
export class BoardInputError extends Error {}

function integer(
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
  field = "offset",
  min = 0,
) {
  if (value === undefined) return fallback;
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < min ||
    Number(value) > max
  )
    throw new BoardInputError(
      `INVALID_BOARD_${field.toUpperCase()}: ${field} must be an integer from ${min} to ${max}`,
    );
  return Number(value);
}
function body(value: unknown, max: number) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("INVALID_BOARD_TEXT");
  return value;
}
function sliceEnd(value: string, end: number) {
  return /[\uD800-\uDBFF]/.test(value[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/.test(value[end] ?? "")
    ? end - 1
    : end;
}
const summary = (task: Task) => ({
  id: task.id,
  title: (task.title ?? task.text).slice(0, 200),
  state: task.state,
  finished: finished(task),
});

// Thread state comes from Tasks. The board never assigns work or grants authority.
export class TaskBoard {
  constructor(readonly store: Repository) {}

  private thread(task: Task): BoardThread {
    return (
      this.store.get<BoardThread>("task-board", task.id) ?? {
        taskId: task.id,
        projectId: task.projectId,
        meetingId: task.meetingId,
        sequence: 0,
        posts: [],
      }
    );
  }
  private target(author: Task, taskId: unknown) {
    if (
      taskId === undefined &&
      author.id === projectDiscussion(author.projectId).id
    )
      return projectDiscussion(author.projectId);
    if (taskId === projectDiscussion(author.projectId).id)
      return projectDiscussion(author.projectId);
    const task = this.store.get<Task>(
      "task",
      taskId === undefined ? author.id : id(taskId),
    );
    if (!task || task.projectId !== author.projectId)
      throw new Error("BOARD_THREAD_NOT_FOUND");
    return task;
  }
  read(author: Task, input: Record<string, unknown> = {}) {
    // Optional tool arguments may be explicitly null. Normalize before choosing
    // listing, thread or post mode; null IDs must not select a different mode.
    input = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== null),
    );
    if (input.scope === "project")
      input = { ...input, taskId: projectDiscussion(author.projectId).id };
    const limit = integer(input.limit, 10, 10, "limit", 1);
    if (
      input.query !== undefined &&
      (typeof input.query !== "string" || input.query.length > 200)
    )
      throw new BoardInputError(
        "INVALID_BOARD_QUERY: query must be a string of at most 200 characters; omit it for an unfiltered read",
      );
    const query =
      input.query === undefined || !(input.query as string).trim()
        ? undefined
        : (input.query as string).toLowerCase();
    if (
      input.includeFinished !== undefined &&
      typeof input.includeFinished !== "boolean"
    )
      throw new BoardInputError(
        "INVALID_BOARD_FILTER: includeFinished must be a boolean",
      );
    if (input.taskId === undefined && input.id === undefined) {
      const threads = this.store
        .list<Task>("task")
        .filter(
          (task) =>
            task.projectId === author.projectId &&
            (input.includeFinished || !finished(task)),
        )
        .map((task) => {
          const posts = this.thread(task).posts;
          const latest = posts.findLast(
            (post) => !query || post.body.toLowerCase().includes(query),
          );
          return {
            ...summary(task),
            postCount: posts.length,
            latestPostId: posts.at(-1)?.id ?? 0,
            ...(latest
              ? { preview: latest.body.slice(0, 600), previewPostId: latest.id }
              : {}),
            matches:
              !query ||
              !!latest ||
              summary(task).title.toLowerCase().includes(query),
          };
        })
        .filter((thread) => thread.matches);
      const start = integer(input.offset, 0);
      return {
        threads: threads
          .slice(start, start + limit)
          .map(({ matches: _matches, ...thread }) => thread),
        nextOffset: start + limit < threads.length ? start + limit : null,
      };
    }
    const task = this.target(author, input.taskId);
    const thread = this.thread(task);
    if (input.id !== undefined) {
      const post = thread.posts.find(
        (post) =>
          post.id === integer(input.id, 0, Number.MAX_SAFE_INTEGER, "id", 1),
      );
      if (!post) throw new Error("BOARD_POST_NOT_FOUND");
      const start = integer(input.offset, 0, post.body.length);
      const end = sliceEnd(post.body, Math.min(post.body.length, start + 4000));
      const { requestKey: _key, ...publicPost } = post;
      return {
        ...publicPost,
        taskId: task.id,
        body: post.body.slice(start, end),
        offset: start,
        nextOffset: end < post.body.length ? end : null,
      };
    }
    const after =
      input.after === undefined
        ? undefined
        : integer(input.after, 0, Number.MAX_SAFE_INTEGER, "after");
    const replyTo =
      input.replyTo === undefined
        ? undefined
        : integer(input.replyTo, 0, Number.MAX_SAFE_INTEGER, "replyTo", 1);
    const matches = thread.posts.filter(
      (post) =>
        (input.before === undefined || post.id < integer(input.before, 0)) &&
        (after === undefined || post.id > after) &&
        (replyTo === undefined || post.replyTo === replyTo) &&
        (!query || post.body.toLowerCase().includes(query)),
    );
    const page =
      after === undefined ? matches.slice(-limit) : matches.slice(0, limit);
    return {
      thread: summary(task),
      posts: page.map(({ requestKey: _key, ...post }) => ({
        ...post,
        body: post.body.slice(0, 600),
        truncated: post.body.length > 600,
      })),
      omitted: matches.length - page.length,
      nextAfter: page.at(-1)?.id ?? after ?? 0,
    };
  }
  post(
    author: Task,
    input: Record<string, unknown>,
    requestKey: string,
    externalAuthor?: string,
    source: "app" | "discord" = "discord",
  ) {
    const content = body(input.body, 16000);
    const key = body(requestKey, 800);
    return this.store.transaction(() => {
      const task = this.target(
        author,
        input.scope === "project"
          ? projectDiscussion(author.projectId).id
          : input.taskId,
      );
      const thread = this.thread(task);
      const replyTo =
        input.replyTo === undefined ? undefined : integer(input.replyTo, 0);
      const previous = thread.posts.find(
        (post) => post.authorTaskId === author.id && post.requestKey === key,
      );
      if (previous) {
        if (previous.body !== content || previous.replyTo !== replyTo)
          throw new Error("BOARD_RETRY_CHANGED");
        return { taskId: task.id, id: previous.id, created: false };
      }
      if (
        replyTo !== undefined &&
        !thread.posts.some((post) => post.id === replyTo)
      )
        throw new Error("BOARD_REPLY_NOT_FOUND");
      const post = {
        authorKind:
          externalAuthor === undefined
            ? ("agent" as const)
            : ("human" as const),
        authorName:
          externalAuthor ??
          (author.clientId
            ? `${this.store.get<{ name?: string; profile?: { name?: string } }>("device", author.clientId)?.profile?.name ?? this.store.get<{ name?: string }>("device", author.clientId)?.name ?? "Agent"} · ${author.agent ?? "codex"}`
            : undefined),
        external: externalAuthor !== undefined && source === "discord",
        id: ++thread.sequence,
        authorTaskId: author.id,
        createdAt: Date.now(),
        body: content,
        replyTo,
        requestKey: key,
      };
      thread.posts.push(post);
      this.store.put("task-board", task.id, thread);
      return { taskId: task.id, id: post.id, created: true };
    });
  }
}
