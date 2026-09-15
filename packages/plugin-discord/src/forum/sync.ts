import { createHash } from "node:crypto";
import { clean, type Task } from "@ido/common/contracts/protocol";

export interface ForumBinding {
  guildId: string;
  issueForumChannelId: string;
  meetingId?: string;
  projectId: string;
  messageContentIntent?: string;
}
export interface ForumRecord {
  lastPost?: number;
  postPart?: number;
  pendingPost?: string;
  error?: string;
  taskId: string;
  marker: string;
  threadId?: string;
  content?: string;
  suppressedUntilRevision?: number;
}
export interface ForumTransport {
  post?(threadId: string, marker: string, content: string): Promise<void>;
  findPost?(threadId: string, marker: string): Promise<boolean>;
  verify?(threadId: string, marker: string): Promise<boolean>;
  find(marker: string): Promise<string | undefined>;
  create(name: string, content: string): Promise<string>;
  update(threadId: string, content: string): Promise<void>;
}
export class ForumCreateRejected extends Error {}
export type ForumTask = Task & {
  discussion?: boolean;
  boardPosts?: Array<{
    id: number;
    body: string;
    author: string;
    external?: boolean;
  }>;
};
export function forumKey(binding: ForumBinding) {
  return `forum-${createHash("sha256")
    .update(
      JSON.stringify([
        binding.guildId,
        binding.issueForumChannelId,
        binding.projectId,
      ]),
    )
    .digest("hex")}`;
}
export function forumContent(
  task: ForumTask,
  marker: string,
  messageContentIntent?: string,
) {
  if (task.discussion)
    return `${marker}\n**${clean(task.title ?? "相談・共有").replace(/@/g, "＠")}**\nIssueに属さない質問・気づき・申し送り。アプリと同じ会話です。投稿だけでは作業を開始しません。タスク化はアプリの「タスクにする」から操作できます。`;
  const title = clean(task.title ?? task.text)
    .replace(/@/g, "＠")
    .slice(0, 500);
  // Logs, credentials, source statements, local paths and patches stay on the Client.
  const shared = task.localMirror
    ? `\n依頼: ${clean(task.text).replace(/@/g, "＠").slice(0, 700)}\n進捗: ${clean(
        task.progress ?? "共有待ち",
      )
        .replace(/@/g, "＠")
        .slice(0, 300)}`
    : "";
  const controls =
    messageContentIntent === "false"
      ? `追加指示: /ido steer task:${task.id}\n停止: /ido stop task:${task.id}`
      : "会話: そのまま投稿（作業は開始しません）\n追加指示: 指示: 内容 / 追加指示: 内容\n終了後の続き: 再開: 内容\n停止: 停止 / 中止 / キャンセル / stop / cancel";
  return `${marker}\n**${title}**\n状態: **${task.state}** · 実行版: ${task.revision}\nTask: \`${task.id}\`\nClient: \`${task.clientId ?? "割り当て待ち"}\`${shared}\n\n${controls}\n詳しい実行ログと承認は各自のIDO Agentで確認してください。`;
}
export class ForumSync {
  private queue: Promise<unknown> = Promise.resolve();
  private records: ForumRecord[] = [];
  private loaded = false;
  constructor(
    readonly binding: ForumBinding,
    readonly transport: ForumTransport,
    readonly read: () => Promise<ForumRecord[] | undefined>,
    readonly write: (records: ForumRecord[]) => Promise<void>,
    readonly valid: () => boolean = () => true,
  ) {}
  async load() {
    if (!this.loaded) {
      this.records = (await this.read()) ?? [];
      this.loaded = true;
    }
  }
  taskForThread(threadId: string) {
    return this.valid()
      ? this.records.find((r) => r.threadId === threadId)?.taskId
      : undefined;
  }
  postCursors() {
    return Object.fromEntries(
      this.records.map((record) => [record.taskId, record.lastPost ?? 0]),
    );
  }
  status() {
    return this.records
      .filter((record) => record.error)
      .map(({ taskId, threadId, error }) => ({ taskId, threadId, error }));
  }
  inspect() {
    const operation = this.queue.then(async () => {
      await this.load();
      for (const record of this.records) {
        if (!this.valid()) throw new Error("FORUM_CONFIG_CHANGED");
        if (!record.threadId || !this.transport.verify) continue;
        try {
          if (!(await this.transport.verify(record.threadId, record.marker)))
            throw new Error("FORUM_STARTER_MISMATCH");
        } catch {
          record.error ??= "FORUM_THREAD_NOT_AVAILABLE";
        }
      }
      await this.write(this.records);
      return this.status();
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  recover(taskId: string, threadId?: string, recreate = false) {
    const operation = this.queue.then(async () => {
      await this.load();
      if (!this.valid()) throw new Error("FORUM_CONFIG_CHANGED");
      const record = this.records.find((record) => record.taskId === taskId);
      if (!record) throw new Error("FORUM_TASK_NOT_FOUND");
      if (recreate)
        this.records = this.records.filter((item) => item !== record);
      else {
        const target = threadId || (await this.transport.find(record.marker));
        if (!target) throw new Error("FORUM_CREATE_UNCERTAIN");
        if (threadId && !(await this.transport.verify?.(target, record.marker)))
          throw new Error("FORUM_STARTER_MISMATCH");
        if (!this.valid()) throw new Error("FORUM_CONFIG_CHANGED");
        await this.transport.update(target, record.content ?? record.marker);
        record.threadId = target;
        record.error = undefined;
      }
      await this.write(this.records);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  sync(tasks: ForumTask[]) {
    const operation = this.queue.then(async () => {
      await this.load();
      let failed = false;
      for (const task of tasks) {
        if (!this.valid()) return;
        if (task.projectId !== this.binding.projectId) continue;
        try {
          let record = this.records.find((r) => r.taskId === task.id);
          let existing = !!record;
          if (record?.suppressedUntilRevision !== undefined) {
            if (task.revision <= record.suppressedUntilRevision) continue;
            delete record.suppressedUntilRevision;
            existing = false;
            await this.write(this.records);
          }
          if (!record) {
            record = { taskId: task.id, marker: `IDO task ${task.id}` };
            this.records.push(record);
            // Persist intent before the non-idempotent Discord create call.
            await this.write(this.records);
          }
          const content = forumContent(
            task,
            record.marker,
            this.binding.messageContentIntent,
          );
          if (!record.threadId) {
            if (existing) {
              record.threadId = await this.transport.find(record.marker);
              if (!record.threadId) throw new Error("FORUM_CREATE_UNCERTAIN");
            } else {
              if (!this.valid()) return;
              try {
                record.threadId = await this.transport.create(
                  `${record.marker} · ${clean(task.title ?? task.text)}`
                    .replace(/[@\r\n]/g, " ")
                    .slice(0, 100),
                  content,
                );
              } catch (error) {
                if (error instanceof ForumCreateRejected) {
                  this.records = this.records.filter((r) => r !== record);
                  await this.write(this.records);
                }
                throw error;
              }
              record.content = content;
            }
            await this.write(this.records);
          }
          if (record.content !== content && this.valid()) {
            await this.transport.update(record.threadId, content);
            record.content = content;
            await this.write(this.records);
          }
          if (this.transport.post && this.transport.findPost) {
            for (const post of task.boardPosts ?? []) {
              if (post.id <= (record.lastPost ?? 0)) continue;
              const body = `${post.author.replace(/@/g, "＠")}\n${post.body.replace(/@/g, "＠")}`;
              const parts = Array.from(
                { length: Math.ceil(body.length / 1700) },
                (_, i) => body.slice(i * 1700, (i + 1) * 1700),
              );
              if (!post.external)
                for (
                  let part = record.postPart ?? 0;
                  part < parts.length;
                  part++
                ) {
                  if (!this.valid()) return;
                  const marker = `IDO board ${task.id}:${post.id}:${part}`;
                  if (record.pendingPost === marker) {
                    if (
                      !(await this.transport.findPost(record.threadId, marker))
                    )
                      throw new Error("FORUM_POST_UNCERTAIN");
                  } else {
                    record.pendingPost = marker;
                    await this.write(this.records);
                    await this.transport.post(
                      record.threadId,
                      marker,
                      parts[part],
                    );
                  }
                  record.pendingPost = undefined;
                  record.postPart = part + 1;
                  await this.write(this.records);
                }
              record.lastPost = post.id;
              record.postPart = undefined;
              await this.write(this.records);
            }
          }
          if (record.error) {
            record.error = undefined;
            await this.write(this.records);
          }
        } catch (error) {
          const record = this.records.find(
            (record) => record.taskId === task.id,
          );
          if (record) {
            record.error = (error as Error).message.startsWith("FORUM_")
              ? (error as Error).message
              : "FORUM_ACCESS_OR_DELIVERY_FAILED";
            await this.write(this.records);
          }
          failed = true;
        }
      }
      if (failed) throw new Error("FORUM_SYNC_INCOMPLETE");
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
export function forumCommand(content: string): "stop" | "steer" | "context" {
  return /^(停止|中止|キャンセル|stop|cancel)$/i.test(content.trim())
    ? "stop"
    : /^(?:指示|追加指示|再開)[:：]/.test(content.trim())
      ? "steer"
      : "context";
}
