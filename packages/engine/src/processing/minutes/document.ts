import { createHash } from "node:crypto";
import {
  MAX_MINUTES_LENGTH,
  taskMarkdown,
  parseTaskUrl,
} from "@ido/common/contracts/api";
import type { Task } from "@ido/common/contracts/protocol";
import type { Meeting, Message } from "../../domain/models.js";
import type { Repository } from "../../ports/repository.js";

export type MinutesGenerator = (
  meeting: Meeting,
  taskLinks: string[],
) => Promise<string>;
type Progress = {
  contextRevision?: number;
  meetingId: string;
  sources: Record<string, string>;
  taskLinks?: string[];
};
const fingerprint = (message: Meeting["messages"][number]) =>
  createHash("sha256")
    .update(JSON.stringify([message.authorId, message.text]))
    .digest("hex");

/** One writer per meeting. Generation never submits work or changes task state. */
export class MinutesDocument {
  private stopped = false;
  stop() {
    this.stopped = true;
  }
  private pending = new Map<string, Promise<void>>();
  constructor(
    readonly store: Repository,
    readonly generate: MinutesGenerator,
  ) {}
  refresh(meetingId: string): Promise<void> {
    const pending = this.pending.get(meetingId);
    if (pending) return pending;
    const result = this.run(meetingId).finally(() =>
      this.pending.delete(meetingId),
    );
    this.pending.set(meetingId, result);
    return result;
  }
  private async run(meetingId: string) {
    if (this.stopped) return;
    const initial = this.store.get<Meeting>("meeting", meetingId);
    if (!initial) return;
    const projectId = initial.projectId ?? "";
    const contextRevision = this.store.get<{ revision: number }>(
      "project-context",
      projectId,
    )?.revision;
    const current = () => {
      if (this.stopped) return;
      if (
        this.store.get("project-lock", projectId) ||
        this.store.get<{ revision: number }>("project-context", projectId)
          ?.revision !== contextRevision
      )
        return;
      return this.store.get<Meeting>("meeting", meetingId);
    };
    let conflicts = 0;
    try {
      for (;;) {
        const meeting = current();
        if (!meeting) return;
        let progress = this.store.get<Progress>(
          "minutes-progress",
          meetingId,
        ) ?? { meetingId, sources: {} };
        if (progress.contextRevision !== contextRevision)
          progress = { meetingId, sources: {}, contextRevision };
        progress.sources = Object.assign(Object.create(null), progress.sources);
        const messages = meeting.messages
          .filter(
            (message) =>
              (contextRevision === undefined ||
                (message as { role?: string }).role !== "assistant") &&
              message.text &&
              progress.sources[message.id] !== fingerprint(message),
          )
          .slice(0, 30);
        const taskLinks = this.store
          .list<Task>("task")
          .filter(
            (task) =>
              task.projectId === projectId && task.meetingId === meetingId,
          )
          .map((task) =>
            taskMarkdown(
              { projectId, taskId: task.id },
              task.title ?? task.text.slice(0, 90),
            ),
          );
        if (
          !messages.length &&
          JSON.stringify(progress.taskLinks ?? []) === JSON.stringify(taskLinks)
        ) {
          meeting.summaryState = "ready";
          this.store.put("meeting", meetingId, meeting);
          return;
        }
        const revision = meeting.summaryRevision ?? 0;
        meeting.summaryState = "updating";
        for (const message of messages) {
          const value = message as Message;
          value.steps = { ...value.steps, minutes: { state: "running" } };
        }
        this.store.put("meeting", meetingId, meeting);
        const markdown = await this.generate(
          {
            ...meeting,
            summary:
              meeting.summaryContextRevision === contextRevision
                ? meeting.summary
                : "",
            messages,
          },
          taskLinks,
        );
        const latest = current();
        if (!latest) return;
        if ((latest.summaryRevision ?? 0) !== revision) {
          if (++conflicts >= 5) throw new Error("MINUTES_CONFLICT");
          continue;
        }
        if (
          typeof markdown !== "string" ||
          !markdown.trim() ||
          markdown.length > MAX_MINUTES_LENGTH
        )
          throw new Error("INVALID_MINUTES");
        // Generated special links must resolve to real tasks. Existing manual links remain intact.
        const existingLinks = new Set(
          meeting.summary.match(/ido:\/\/[^\s)]+/g) ?? [],
        );
        for (const link of markdown.match(/ido:\/\/[^\s)]+/g) ?? []) {
          if (existingLinks.has(link)) continue;
          const reference = parseTaskUrl(link);
          const task =
            reference && this.store.get<Task>("task", reference.taskId);
          if (
            !task ||
            task.projectId !== reference?.projectId ||
            task.projectId !== projectId
          )
            throw new Error("INVALID_TASK_REFERENCE");
        }
        latest.summary = markdown;
        latest.summaryContextRevision = contextRevision;
        latest.summaryRevision = revision + 1;
        latest.summaryUpdatedAt = Date.now();
        latest.summaryState = "ready";
        for (const message of latest.messages) {
          if (
            messages.some(
              (m) =>
                m.id === message.id && fingerprint(m) === fingerprint(message),
            )
          ) {
            const value = message as Message;
            value.steps = { ...value.steps, minutes: { state: "completed" } };
          }
        }
        progress.taskLinks = taskLinks;
        for (const message of messages)
          progress.sources[message.id] = fingerprint(message);
        this.store.transaction(() => {
          this.store.put("meeting", meetingId, latest);
          this.store.put("minutes-progress", meetingId, progress);
        });
        // Re-read after every await, including new or revised speech segments.
      }
    } catch (error) {
      const meeting = current();
      if (!meeting) return;
      meeting.summaryState = "failed";
      for (const message of meeting.messages) {
        const value = message as Message;
        if (["pending", "running"].includes(value.steps?.minutes?.state ?? ""))
          value.steps = { ...value.steps, minutes: { state: "failed" } };
      }
      this.store.put("meeting", meetingId, meeting);
      this.store.logError(error, {
        source: "meeting",
        operation: "minutes.generate",
        meetingId,
      });
    }
  }
}
