import { randomUUID } from "node:crypto";
import { id, text, type Project } from "@ido/common/contracts/protocol";
import type { ConversationInput } from "@ido/common/contracts/plugins";
import type { Repository } from "../../ports/repository.js";
import type { Meeting } from "../../domain/models.js";

export const DEFAULT_PROJECT = "default";
type Conversation = {
  projectId: string;
  meetingId: string;
  coordinatorId: string;
  lastHumanAt?: number;
};
export class Projects {
  constructor(
    readonly store: Repository,
    readonly now = Date.now,
  ) {}
  ensure() {
    this.store.transaction(() => {
      if (!this.store.get("project", DEFAULT_PROJECT))
        this.store.put("project", DEFAULT_PROJECT, {
          id: DEFAULT_PROJECT,
          name: "デフォルト",
          remote: "",
          isDefault: true,
        });
      this.current(DEFAULT_PROJECT);
      for (const voice of this.store.list<{ id?: string; endedAt?: number }>(
        "voice-route",
      ))
        if (voice.id && voice.endedAt === undefined)
          this.store.put("voice-route", voice.id, {
            ...voice,
            endedAt: this.now(),
          });
    });
  }
  create(name: unknown, requestKey: string, remote = "") {
    const normalized = text(text(name, 100).normalize("NFKC"), 100);
    return this.store.transaction(() => {
      const receipt = this.store.get<{ name: string; projectId: string }>(
        "project-create",
        requestKey,
      );
      if (receipt) {
        if (!this.store.get("project", receipt.projectId))
          throw new Error("PROJECT_DELETED");
        if (receipt.name !== normalized)
          throw new Error("PROJECT_REQUEST_MISMATCH");
        return this.store.get<Project>("project", receipt.projectId)!;
      }
      if (
        this.store
          .list<Project>("project")
          .some(
            (p) =>
              p.name.normalize("NFKC").toLowerCase() ===
              normalized.toLowerCase(),
          )
      )
        throw new Error("PROJECT_NAME_EXISTS");
      const project: Project = { id: randomUUID(), name: normalized, remote };
      this.store.put("project", project.id, project);
      this.store.put("project-create", requestKey, {
        name: normalized,
        projectId: project.id,
      });
      return project;
    });
  }
  project(projectId?: string, meetingId?: string) {
    const meeting = meetingId
      ? this.store.get<Meeting>("meeting", id(meetingId))
      : undefined;
    if (meetingId && !meeting) throw new Error("MEETING_NOT_FOUND");
    if (projectId && meeting?.projectId && projectId !== meeting.projectId)
      throw new Error("INPUT_BINDING_MISMATCH");
    const selected = projectId || meeting?.projectId || DEFAULT_PROJECT;
    if (this.store.get("project-lock", selected))
      throw new Error("WORKSPACE_CONFLICT");
    if (!this.store.get("project", id(selected)))
      throw new Error("PROJECT_NOT_FOUND");
    return selected;
  }
  current(projectId: string): Conversation {
    const saved = this.store.get<Conversation>(
      "project-conversation",
      projectId,
    );
    if (saved) return saved;
    const existing = this.store
      .list<Meeting>("meeting")
      .filter((m) => m.projectId === projectId);
    const anchor = existing.findLast((m) =>
      this.store.get("coordinator", m.id),
    );
    const meetingId = randomUUID();
    this.store.put("meeting", meetingId, {
      id: meetingId,
      projectId,
      name: this.title(this.now()),
      startedAt: this.now(),
      summary: "",
      messages: [],
    });
    const state = {
      projectId,
      meetingId,
      coordinatorId: anchor?.id ?? meetingId,
    };
    this.store.put("project-conversation", projectId, state);
    return state;
  }
  title(at: number) {
    return `議事録 ${new Date(at).toISOString().replace("T", " ").slice(0, 16)} UTC`;
  }
  accept(
    event: Omit<ConversationInput, "meetingId"> & { meetingId?: string },
    origin: string,
  ): ConversationInput {
    return this.store.transaction(() => {
      const projectId = this.project(event.projectId, event.meetingId);
      const receiptKey = `${origin}:${event.eventId}`;
      const previous = this.store.get<{ meetingId: string; projectId: string }>(
        "conversation-route",
        receiptKey,
      );
      if (previous) {
        if (previous.projectId !== projectId)
          throw new Error("INPUT_BINDING_MISMATCH");
        return { ...event, ...previous };
      }
      const state = this.current(projectId);
      const now = this.now();
      const captureKey = event.capture
        ? `${origin}:${event.capture.sessionId}:${event.capture.utteranceId}`
        : undefined;
      const capture = captureKey
        ? this.store.get<{ meetingId: string; projectId: string }>(
            "utterance-route",
            captureKey,
          )
        : undefined;
      if (capture && capture.projectId !== projectId)
        throw new Error("INPUT_BINDING_MISMATCH");
      const voiceKey = `${origin}:${projectId}:${event.subject ?? ""}`;
      const voice = this.store.get<{
        meetingId: string;
        startedAt: number;
        endedAt?: number;
      }>("voice-route", voiceKey);
      const inVoice =
        voice &&
        (voice.endedAt === undefined ||
          (event.capture &&
            event.capture.startedAt <= voice.endedAt &&
            event.capture.startedAt >= voice.startedAt));
      const human =
        !!event.text?.trim() ||
        !!event.audio ||
        event.activity === "start" ||
        event.activity === "end";
      const interval =
        Number(
          this.store.get<Record<string, string>>("config", "engine")
            ?.minutesIdleMinutes ?? 10,
        ) * 60_000;
      const activeVoice = this.store
        .list<{ projectId?: string; endedAt?: number }>("voice-route")
        .some((v) => v.projectId === projectId && v.endedAt === undefined);
      if (
        human &&
        !capture &&
        !inVoice &&
        !activeVoice &&
        state.lastHumanAt !== undefined &&
        now - state.lastHumanAt >= interval
      ) {
        const old = this.store.get<Meeting>("meeting", state.meetingId)!;
        this.store.put("meeting", old.id, {
          ...old,
          closedAt: state.lastHumanAt,
        });
        state.meetingId = randomUUID();
        this.store.put("meeting", state.meetingId, {
          id: state.meetingId,
          projectId,
          name: this.title(now),
          startedAt: now,
          summary: "",
          messages: [],
        });
      }
      const meetingId =
        capture?.meetingId ?? (inVoice ? voice.meetingId : state.meetingId);
      if (human && meetingId === state.meetingId) state.lastHumanAt = now;
      this.store.put("project-conversation", projectId, state);
      if (event.activity === "start")
        this.store.put("voice-route", voiceKey, {
          id: voiceKey,
          projectId,
          meetingId,
          startedAt: now,
        });
      if (event.activity === "end" && voice)
        this.store.put("voice-route", voiceKey, {
          ...voice,
          projectId,
          endedAt: now,
        });
      if (captureKey && !capture)
        this.store.put("utterance-route", captureKey, { meetingId, projectId });
      // PCM and activity events are transient; durable text/utterance inputs are pinned.
      if (!event.audioFrame && !event.activity)
        this.store.put("conversation-route", receiptKey, {
          meetingId,
          projectId,
        });
      return { ...event, projectId, meetingId };
    });
  }
}
