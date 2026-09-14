import { id, type Task } from "@ido/common/contracts/protocol";
import type { Repository } from "../../ports/repository.js";

interface Post {
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
function integer(
  value: unknown,
  fallback: number,
  max = Number.MAX_SAFE_INTEGER,
) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > max)
    throw new Error("INVALID_BOARD_OFFSET");
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
    const task = this.store.get<Task>(
      "task",
      taskId === undefined ? author.id : id(taskId),
    );
    if (!task || task.projectId !== author.projectId)
      throw new Error("BOARD_THREAD_NOT_FOUND");
    return task;
  }
  read(author: Task, input: Record<string, unknown> = {}) {
    const limit = integer(input.limit, 10, 10);
    if (!limit) throw new Error("INVALID_BOARD_LIMIT");
    const query =
      input.query === undefined
        ? undefined
        : body(input.query, 200).toLowerCase();
    if (
      input.includeFinished !== undefined &&
      typeof input.includeFinished !== "boolean"
    )
      throw new Error("INVALID_BOARD_FILTER");
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
        (post) => post.id === integer(input.id, 0),
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
      input.after === undefined ? undefined : integer(input.after, 0);
    const replyTo =
      input.replyTo === undefined ? undefined : integer(input.replyTo, 0);
    const matches = thread.posts.filter(
      (post) =>
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
  post(author: Task, input: Record<string, unknown>, requestKey: string) {
    const content = body(input.body, 16000);
    const key = body(requestKey, 800);
    return this.store.transaction(() => {
      const task = this.target(author, input.taskId);
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
