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
      latest.summary = meeting.summary;
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
      const parsed = await this.models.update(
        contextRevision === undefined
          ? meeting
          : {
              ...meeting,
              summary: "",
              messages: meeting.messages
                .filter((m) => (m as { role?: string }).role !== "assistant")
                .map(({ id, authorId, text, at, stage }) => ({
                  id,
                  authorId,
                  text,
                  at,
                  stage,
                })),
            },
        messageId,
      );
      if (
        !this.store.get("meeting", meetingId) ||
        contextRevision !==
          this.store.get<{ revision: number }>(
            "project-context",
            meeting.projectId ?? "",
          )?.revision
      )
        throw new Error("WORKSPACE_CONFLICT");
      meeting.summary = parsed.minutes;
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
