import { Implementations } from "../tasks/implementations.js";
import {
  previewMarkdown,
  parsePreviewUrl,
  type Implementation,
} from "@ido/common/contracts/api";
import { taskResultParts, type ResultProgress } from "./task-results.js";
import type {
  MinutesTaskContext,
  MinutesTaskResult,
} from "@ido/common/contracts/work";
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
  taskResults: MinutesTaskResult[],
  tasks: MinutesTaskContext[],
  implementations: Implementation[],
) => Promise<string>;
type Progress = {
  contextRevision?: number;
  meetingId: string;
  sources: Record<string, string>;
  taskLinks?: string[];
  implementations?: string;
  taskContextFingerprint?: string;
  results?: Record<string, ResultProgress>;
};
const fingerprint = (message: Meeting["messages"][number]) =>
  createHash("sha256")
    .update(JSON.stringify([message.authorId, message.text]))
    .digest("hex");

function minutesTaskContexts(tasks: Task[]): MinutesTaskContext[] {
  return tasks.map((task) => ({
    taskId: task.id,
    title: task.title ?? task.text.slice(0, 90),
    link: taskMarkdown(
      { projectId: task.projectId, taskId: task.id },
      task.title ?? task.text.slice(0, 90),
    ),
    text: task.text.slice(0, 2000),
    state: task.state,
    sourceIds:
      task.sourceIds?.slice(0, 20) ?? (task.requestId ? [task.requestId] : []),
    runId: task.runId,
    revision: task.revision,
  }));
}
const contextFingerprint = (tasks: MinutesTaskContext[]) =>
  createHash("sha256").update(JSON.stringify(tasks)).digest("hex");

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
        const meetingTasks = this.store
          .list<Task>("task")
          .filter(
            (task) =>
              task.projectId === projectId && task.meetingId === meetingId,
          );
        const artifacts = new Implementations(this.store)
          .choices(projectId, meetingId)
          .flatMap((choice) =>
            choice.implementation ? [choice.implementation] : [],
          );
        const artifactFingerprint = JSON.stringify(
          artifacts.map((a) => a.id).sort(),
        );
        const tasks = minutesTaskContexts(meetingTasks);
        const taskContextFingerprint = contextFingerprint(tasks);
        const resultParts = taskResultParts(meetingTasks, progress.results);
        const taskLinks = meetingTasks.map((task) =>
          taskMarkdown(
            { projectId, taskId: task.id },
            task.title ?? task.text.slice(0, 90),
          ),
        );
        if (
          (progress.implementations ?? "[]") === artifactFingerprint &&
          !messages.length &&
          !resultParts.length &&
          (progress.taskContextFingerprint ?? contextFingerprint([])) ===
            taskContextFingerprint &&
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
        let markdown = await this.generate(
          {
            ...meeting,
            summary:
              meeting.summaryContextRevision === contextRevision
                ? meeting.summary
                : "",
            messages,
          },
          taskLinks,
          resultParts.map((part) => part.value),
          tasks,
          artifacts,
        );
        markdown = markdown.replace(
          /\{\{preview:([\w-]+)(?:,([\w-]+))?\}\}/g,
          (_match, left: string, right?: string) => {
            const ids = [left, right].filter((v): v is string => !!v);
            if (
              ids.some(
                (id) => !artifacts.some((artifact) => artifact.id === id),
              )
            )
              throw new Error("INVALID_PREVIEW_REFERENCE");
            return previewMarkdown({ projectId, implementationIds: ids });
          },
        );
        const latest = current();
        if (!latest) return;
        const currentTasks = this.store
          .list<Task>("task")
          .filter(
            (task) =>
              task.projectId === projectId && task.meetingId === meetingId,
          );
        const currentParts = taskResultParts(currentTasks, progress.results);
        if (
          JSON.stringify(
            new Implementations(this.store)
              .choices(projectId, meetingId)
              .flatMap((choice) =>
                choice.implementation ? [choice.implementation.id] : [],
              )
              .sort(),
          ) !== artifactFingerprint ||
          (latest.summaryRevision ?? 0) !== revision ||
          contextFingerprint(minutesTaskContexts(currentTasks)) !==
            taskContextFingerprint ||
          JSON.stringify(
            currentParts.map(({ key, progress }) => ({ key, progress })),
          ) !==
            JSON.stringify(
              resultParts.map(({ key, progress }) => ({ key, progress })),
            )
        ) {
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
          const preview = parsePreviewUrl(link);
          if (preview) {
            if (
              preview.projectId !== projectId ||
              preview.implementationIds.some(
                (id) => !artifacts.some((a) => a.id === id),
              )
            )
              throw new Error("INVALID_PREVIEW_REFERENCE");
            continue;
          }
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
        progress.implementations = artifactFingerprint;
        progress.taskContextFingerprint = taskContextFingerprint;
        progress.results = Object.assign(Object.create(null), progress.results);
        for (const part of resultParts)
          progress.results![part.key] = part.progress;
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
