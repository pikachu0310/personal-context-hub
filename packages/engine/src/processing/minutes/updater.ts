import { MAX_MINUTES_LENGTH } from "@ido/common/contracts/api";
import type { DiagnosticContext } from "../../domain/diagnostics.js";
import type { Meeting, Message } from "../../domain/models.js";
import { Messages } from "../../messages/store.js";
import type { Models } from "../../ports/models.js";
import type { Repository } from "../../ports/repository.js";
import { Tasks } from "../tasks/service.js";
export interface MinutesReservation {
  ready: Promise<unknown>;
  release(): void;
}
export class MinutesUpdater {
  private queues = new Map<string, Promise<unknown>>();
  readonly tasks: Tasks;
  readonly messages: Messages;
  constructor(
    readonly store: Repository,
    readonly models: Models,
  ) {
    this.tasks = new Tasks(store);
    this.messages = new Messages(store);
  }
  reserve(meetingId: string): MinutesReservation {
    const ready = this.queues.get(meetingId) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = ready.then(() => done);
    this.queues.set(meetingId, tail);
    void tail.then(() => {
      if (this.queues.get(meetingId) === tail) this.queues.delete(meetingId);
    });
    return { ready, release };
  }
  process(
    meetingId: string,
    authorId: string,
    text: string,
    projectId?: string | null,
    onAccepted?: (meeting: Meeting) => void,
    mayCreateTask: () => boolean = () => true,
    diagnosticContext?: Pick<DiagnosticContext, "source" | "eventId">,
    acceptedMessageId?: string,
    reservation?: MinutesReservation,
    sourcePluginId?: string,
  ) {
    const { meeting, message } = this.messages.record(
      meetingId,
      authorId,
      text,
      acceptedMessageId,
    );
    onAccepted?.(meeting);
    const turn = reservation ?? this.reserve(meetingId);
    const next = turn.ready
      .then(() =>
        this.analyze(
          meetingId,
          message.id,
          projectId,
          mayCreateTask,
          diagnosticContext,
          sourcePluginId,
        ),
      )
      .finally(turn.release);
    return next;
  }
  private async analyze(
    meetingId: string,
    messageId: string,
    projectId: string | null | undefined,
    mayCreateTask: () => boolean,
    diagnosticContext?: Pick<DiagnosticContext, "source" | "eventId">,
    sourcePluginId?: string,
  ) {
    const meeting = this.store.get<Meeting>("meeting", meetingId);
    if (!meeting) throw new Error("MEETING_NOT_FOUND");
    const contextRevision = this.store.get<{ revision: number }>(
      "project-context",
      meeting.projectId ?? "",
    )?.revision;
    const message = meeting.messages.find((m) => m.id === messageId)!;
    const authorId = message.authorId;
    const save = () => {
      const latest = this.store.get<Meeting>("meeting", meetingId);
      if (
        !latest ||
        contextRevision !==
          this.store.get<{ revision: number }>(
            "project-context",
            meeting.projectId ?? "",
          )?.revision
      )
        throw new Error("WORKSPACE_CONFLICT");

      if (message.stage === "analyzing") latest.summaryState = "updating";
      const index = latest.messages.findIndex((m) => m.id === messageId);
      if (index >= 0)
        latest.messages[index] = {
          ...latest.messages[index],
          ...message,
          steps: {
            ...(latest.messages[index] as Message).steps,
            minutes: {
              state:
                message.stage === "completed"
                  ? "completed"
                  : message.stage === "failed"
                    ? "failed"
                    : "running",
              errorId: message.errorId,
            },
          },
        } as Message;
      this.store.put("meeting", meetingId, latest);
      return latest;
    };
    try {
      message.stage = "analyzing";
      save();
      let parsed: { minutes: string; task: string | null };
      for (let attempt = 0; ; attempt++) {
        const base = this.store.get<Meeting>("meeting", meetingId);
        if (!base) throw new Error("MEETING_NOT_FOUND");
        parsed = await this.models.update(
          {
            ...base,
            summary:
              base.summaryContextRevision === contextRevision
                ? base.summary
                : "",
            messages:
              contextRevision === undefined
                ? base.messages
                : base.messages.filter(
                    (m) => (m as { role?: string }).role !== "assistant",
                  ),
          },
          messageId,
        );
        const latest = this.store.get<Meeting>("meeting", meetingId);
        if (
          !latest ||
          contextRevision !==
            this.store.get<{ revision: number }>(
              "project-context",
              meeting.projectId ?? "",
            )?.revision
        )
          throw new Error("WORKSPACE_CONFLICT");
        if ((latest.summaryRevision ?? 0) !== (base.summaryRevision ?? 0)) {
          if (attempt >= 4) throw new Error("MINUTES_CONFLICT");
          continue;
        }
        if (
          typeof parsed.minutes !== "string" ||
          parsed.minutes.length > MAX_MINUTES_LENGTH
        )
          throw new Error("INVALID_MINUTES");
        latest.summary = parsed.minutes;
        latest.summaryContextRevision = contextRevision;
        latest.summaryRevision = (latest.summaryRevision ?? 0) + 1;
        latest.summaryUpdatedAt = Date.now();
        latest.summaryState = "ready";
        this.store.put("meeting", meetingId, latest);
        meeting.summary = parsed.minutes;
        break;
      }
      const target =
        projectId === null ? undefined : (projectId ?? meeting.projectId);
      // Model output supplies task content only. Actor, project and grants come from trusted local records.
      if (
        mayCreateTask() &&
        parsed.task &&
        target &&
        this.store.conversationAuthor(authorId)?.role !== "viewer" &&
        this.store.conversationAuthor(authorId)
      ) {
        message.stage = "taskifying";
        save();
        this.tasks.createTask({
          sourcePluginId,
          createdByBot: sourcePluginId === "discord" ? true : undefined,
          projectId: target,
          meetingId,
          authorId,
          requestId: message.id,
          text: `${parsed.task}\n\nMeeting context:\n${meeting.summary}`,
          network: false,
        });
      }
      message.stage = "completed";
    } catch (error) {
      if (message.stage === "analyzing") {
        const latest = this.store.get<Meeting>("meeting", meetingId);
        if (latest) {
          latest.summaryState = "failed";
          this.store.put("meeting", meetingId, latest);
        }
      }
      message.errorId = this.store.logError(error, {
        source: "meeting",
        ...diagnosticContext,
        operation:
          message.stage === "taskifying" ? "task.create" : "minutes.generate",
        meetingId,
        messageId,
        model: message.stage === "taskifying" ? undefined : "gpt-4.1-mini",
      }).id;
      message.stage = "failed";
    }
    return save();
  }
}
