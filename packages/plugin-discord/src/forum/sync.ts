import { createHash } from "node:crypto";
import { clean, type Task } from "../../../common/src/contracts/protocol.js";

export interface ForumBinding {
  guildId: string;
  issueForumChannelId: string;
  meetingId: string;
  projectId: string;
}
export interface ForumRecord {
  taskId: string;
  marker: string;
  threadId?: string;
  content?: string;
}
export interface ForumTransport {
  find(marker: string): Promise<string | undefined>;
  create(name: string, content: string): Promise<string>;
  update(threadId: string, content: string): Promise<void>;
}
export class ForumCreateRejected extends Error {}
export function forumKey(binding: ForumBinding) {
  return `forum-${createHash("sha256")
    .update(
      JSON.stringify([
        binding.guildId,
        binding.issueForumChannelId,
        binding.meetingId,
        binding.projectId,
      ]),
    )
    .digest("hex")}`;
}
export function forumContent(task: Task, marker: string) {
  const title = clean(task.title ?? task.text)
    .replace(/@/g, "＠")
    .slice(0, 500);
  // Logs, credentials, source statements, local paths and patches stay on the Client.
  return `${marker}\n**${title}**\n状態: **${task.state}** · 実行版: ${task.revision}\nTask: \`${task.id}\`\nClient: \`${task.clientId ?? "割り当て待ち"}\`\n\n追加指示: このスレッドにメッセージを送信\n停止: 停止 / 中止 / キャンセル / stop / cancel\n詳しい実行ログと承認は各自のIDO Agentで確認してください。`;
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
  sync(tasks: Task[]) {
    const operation = this.queue.then(async () => {
      await this.load();
      let failed = false;
      for (const task of tasks) {
        if (!this.valid()) return;
        if (
          task.meetingId !== this.binding.meetingId ||
          task.projectId !== this.binding.projectId
        )
          continue;
        try {
          let record = this.records.find((r) => r.taskId === task.id);
          const existing = !!record;
          if (!record) {
            record = { taskId: task.id, marker: `IDO task ${task.id}` };
            this.records.push(record);
            // Persist intent before the non-idempotent Discord create call.
            await this.write(this.records);
          }
          const content = forumContent(task, record.marker);
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
        } catch {
          failed = true;
        }
      }
      if (failed) throw new Error("FORUM_SYNC_INCOMPLETE");
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
export function forumCommand(content: string): "stop" | "steer" {
  return /^(停止|中止|キャンセル|stop|cancel)$/i.test(content.trim())
    ? "stop"
    : "steer";
}
