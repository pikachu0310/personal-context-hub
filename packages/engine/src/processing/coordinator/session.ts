import { ProjectTeam } from "../projects/team.js";
import { createHash } from "node:crypto";
import type {
  ConversationMode,
  CoordinatorEvent,
  CoordinatorObservation,
  CoordinatorSource,
  CoordinatorFactory,
  SpeechReview,
  SpeechDecision,
} from "@ido/common/contracts/coordinator";
import type {
  ConversationInput,
  InputContext,
  PluginEvent,
} from "@ido/common/contracts/plugins";
import type { Meeting, Message } from "../../domain/models.js";
import { Messages } from "../../messages/store.js";
import type { Repository } from "../../ports/repository.js";
import type { WorkPort, WorkResult } from "../../ports/work.js";
import { ConversationAudio } from "../../output/audio/session.js";
import { parseBotInvocation } from "../immediate/invocation.mjs";
import {
  deferredDelegation,
  explicitDelegation,
  proactiveOpportunity,
} from "./intent.mjs";
import { taskControl } from "../routing/control.js";
import type { Task } from "@ido/common/contracts/protocol";
import { CoordinatorInbox } from "./inbox.mjs";
import { MeetingKnowledgeStore } from "../minutes/knowledge.js";
import { duplicateWork } from "./duplicates.js";
import { describeError } from "../../domain/diagnostics.js";
import {
  CoordinatorTraces,
  sourceRejection,
  type ModelValue,
  type TaskApplication,
} from "./traces.js";

type Route = { event: ConversationInput; context: InputContext };
type StoredState = {
  mode: ConversationMode;
  modeRevision: number;
  inbox?: any;
  completed?: string[];
};
type Batch = { id: string; events: CoordinatorEvent[] };
export interface CoordinatedOptions {
  coordinator: CoordinatorFactory;
  updateMinutes?: (meetingId: string) => Promise<void>;
  work: WorkPort;
  synthesize(text: string): Promise<string>;
  createLiveSession?: any;
  mode?: ConversationMode;
  observationIntervalMs?: number;
  publish(event: PluginEvent): void;
}

const stableId = (value: string) =>
  createHash("sha256").update(value).digest("hex");

// One project owns one inbox and model handle, anchored to a stable minutes ID. Records are the state
// authority; model hosts, work executors and audio devices are replaceable ports.
class MeetingCoordinator {
  readonly inbox: CoordinatorInbox;
  readonly audio: ConversationAudio;
  readonly messages: Messages;
  readonly routes = new Map<string, Route>();
  readonly completed: Set<string>;
  readonly timer: NodeJS.Timeout;
  lastRoute?: Route;
  modeRevision: number;
  closed = false;
  private speechReviews = new Map<
    string,
    (decision?: SpeechDecision | null) => void
  >();
  constructor(
    readonly store: Repository,
    readonly meetingId: string,
    readonly options: CoordinatedOptions,
  ) {
    this.messages = new Messages(store);
    const saved = store.get<StoredState>("coordinator", meetingId);
    this.modeRevision = saved?.modeRevision ?? 0;
    this.completed = new Set(saved?.completed ?? []);
    this.audio = new ConversationAudio({
      mode: saved?.mode ?? options.mode ?? "text-speech",
      createLiveSession: options.createLiveSession,
      synthesize: options.synthesize,
      reviewSpeech: (review, signal) => this.reviewSpeech(review, signal),
      currentResults: () =>
        this.projectTasks().flatMap((task) => {
          const result = options.work.getResult(task.id);
          return result
            ? [
                {
                  id: result.id,
                  runRevision: result.runRevision,
                  superseded: result.superseded,
                },
              ]
            : [];
        }),
      recordAssistant: (event: any) => this.assistant(event),
      onDelegation: (event: any) => this.attention(event),
      onError: (error: unknown) => this.failure(error, "audio.session"),
    });
    this.inbox = new CoordinatorInbox({
      initialState: saved?.inbox,
      createRuntime: async ({ onCheckpoint }: any) => {
        const runtime = await options.coordinator.createCoordinator({
          meetingId,
          projectId: this.meeting()?.projectId,
          handle: (this.inbox.snapshot() as any).handle,
          onCheckpoint,
        });
        return {
          run: async (observation: CoordinatorObservation, runOptions: any) => {
            const modeRevision = this.modeRevision;
            const audioRevision = this.audio.turns.revision;
            const controlVersions = Object.fromEntries(
              this.projectTasks().map((task) => [
                task.id,
                task.controlVersion ?? 0,
              ]),
            );
            return {
              response: await new CoordinatorTraces(this.store).model(
                this.inbox.snapshot().active!.id,
                "run",
                observation,
                () => runtime.run(observation, runOptions),
              ),
              modeRevision,
              audioRevision,
              controlVersions,
            };
          },
          steer: (observation: CoordinatorObservation) =>
            new CoordinatorTraces(this.store).model(
              this.inbox.snapshot().active!.id,
              "steer",
              observation,
              () => runtime.steer(observation),
            ),
          interrupt: () => runtime.interrupt(),
          close: () => runtime.close(),
        };
      },
      buildObservation: (events: CoordinatorEvent[]) =>
        this.observation(events),
      checkpoint: (inbox: unknown) => this.save(inbox),
      onResponse: (value: any, batch: Batch) => this.apply(value, batch),
      onError: (error: unknown) => this.failure(error, "coordinator.run"),
    } as any);
    this.timer = setInterval(() => {
      void this.inbox.flush();
    }, options.observationIntervalMs ?? 12_000);
    this.timer.unref();
  }

  private reviewSpeech(
    review: SpeechReview,
    signal: AbortSignal,
  ): Promise<SpeechDecision | null | undefined> {
    if (this.closed || signal.aborted) return Promise.resolve(undefined);
    const id = `speech-review:${review.candidateId}:${review.revision}`;
    return new Promise((resolve) => {
      const settle = (decision?: SpeechDecision | null) => {
        signal.removeEventListener("abort", aborted);
        this.speechReviews.delete(id);
        resolve(decision);
      };
      const aborted = () => settle();
      signal.addEventListener("abort", aborted, { once: true });
      this.speechReviews.set(id, settle);
      void this.inbox
        .submit([{ id, type: "speech_review", review }], { urgent: true })
        .catch(() => settle());
    });
  }

  meeting(meetingId = this.meetingId) {
    return this.store.get<Meeting>("meeting", meetingId);
  }
  projectMeetings() {
    const projectId = this.meeting()?.projectId;
    return this.store
      .list<Meeting>("meeting")
      .filter((m) =>
        projectId ? m.projectId === projectId : m.id === this.meetingId,
      );
  }
  projectTasks() {
    const projectId = this.meeting()?.projectId;
    return this.options.work
      .list()
      .filter((t) =>
        projectId ? t.projectId === projectId : t.meetingId === this.meetingId,
      );
  }
  save(inbox: unknown = this.inbox.snapshot()) {
    const savedInbox = structuredClone(inbox) as any;
    if (savedInbox) {
      const durable = (events: CoordinatorEvent[] = []) =>
        events.filter((event) => event.type !== "speech_review");
      savedInbox.pending = durable(savedInbox.pending);
      if (savedInbox.active) {
        savedInbox.active.events = durable(savedInbox.active.events);
        savedInbox.active.steering = durable(savedInbox.active.steering);
        if (!savedInbox.active.events.length) savedInbox.active = undefined;
      }
    }
    this.store.put("coordinator", this.meetingId, {
      version: 1,
      mode: this.audio.mode,
      modeRevision: this.modeRevision,
      inbox: savedInbox,
      completed: [...this.completed].slice(-200),
    });
  }
  failure(error: unknown, operation: string) {
    if (this.closed) return;
    this.store.logError(error, {
      source: "conversation",
      operation,
      meetingId: this.meetingId,
    });
    for (const event of (this.inbox?.snapshot().active?.events ??
      []) as CoordinatorEvent[]) {
      if (event.type !== "message") continue;
      this.messages.step(event.source.id, "reply", "interrupted");
      this.messages.stage(event.source.id, "interrupted");
    }
    this.publish("transcript");
  }
  publish(
    type: "transcript" | "minutes",
    meetingId = this.lastRoute?.event.meetingId ?? this.meetingId,
  ) {
    const meeting = this.meeting(meetingId);
    if (meeting)
      this.options.publish({ type, meetingId: meeting.id, data: meeting });
  }
  active(route?: Route) {
    return (
      !!route &&
      route.context.valid() &&
      !!this.store.conversationAuthor(route.context.actor.id)
    );
  }
  source(event: CoordinatorEvent): CoordinatorSource | undefined {
    return event.type === "message" ? event.source : undefined;
  }
  async receipt(
    source: CoordinatorSource,
    key: string,
    content: string,
    taskIds: string[],
  ) {
    const route = this.routes.get(source.id);
    if (!this.active(route)) return;
    const id = `receipt:${stableId(key)}`;
    if (this.store.get("conversation-output", id)) return;
    const output = {
      id,
      meetingId: source.meetingId ?? this.meetingId,
      provider: "engine",
      role: "assistant",
      text: content,
      sourceIds: [source.id],
      taskIds,
      at: Date.now(),
      delivered: false,
      deliveryStatus: "unknown",
    };
    // Persist before sending: uncertain delivery is never retried as a second announcement.
    this.store.put("conversation-output", id, output);
    this.messages.response(source.id, content);
    try {
      await route!.context.deliver({
        kind: "reply",
        eventId: id,
        content,
        replyTo: route!.event.replyTo,
      });
      output.delivered = true;
      output.deliveryStatus = "delivered";
      this.store.put("conversation-output", id, output);
      this.messages.step(source.id, "delivery", "completed");
    } catch (error) {
      this.failure(error, "conversation.receipt");
    }
    if (source.origin === "audio")
      void this.audio
        .reply(
          {
            text: content,
            sourceIds: [source.id],
            reason: this.audio.mode === "live" ? "backend" : "direct",
            events: [{ id: source.id, type: "message", source }],
          },
          route!.context,
        )
        .catch((error) => this.failure(error, "audio.receipt"));
    this.publish("transcript", source.meetingId);
  }
  permitted(source: CoordinatorSource) {
    const route = this.routes.get(source.id);
    const actor = this.store.conversationAuthor(source.authorId);
    return (
      this.active(route) &&
      !!actor &&
      actor.role !== "viewer" &&
      route!.context.actor.id === source.authorId
    );
  }
  controlCandidates(
    source: CoordinatorSource,
    parsed: NonNullable<ReturnType<typeof taskControl>>,
  ) {
    return this.projectTasks().filter(
      (task) =>
        task.projectId === source.projectId &&
        (parsed.action === "stop"
          ? ["queued", "assigned", "running", "interrupted"]
          : ["queued", "assigned", "running", "completed"]
        ).includes(task.state) &&
        (!parsed.taskId || task.id.startsWith(parsed.taskId)) &&
        (!parsed.target || (task.title ?? task.text).includes(parsed.target)),
    );
  }
  async applyControl(
    source: CoordinatorSource,
    target: Task,
    parsed: NonNullable<ReturnType<typeof taskControl>>,
    key: string,
    version = target.controlVersion ?? 0,
  ) {
    try {
      const continuation =
        parsed.action === "steer" && target.state === "completed";
      const result = this.options.work.control({
        sourcePluginId: this.routes.get(source.id)?.context.pluginId,
        taskId: target.id,
        authorId: source.authorId,
        type:
          parsed.action === "stop"
            ? "stop"
            : continuation
              ? "retry"
              : "instruction",
        instruction: parsed.instruction,
        ...(continuation ? { continuation: parsed.instruction } : {}),
        requestKey: key,
        expectedControlVersion: version,
      });
      await this.receipt(
        source,
        key,
        `タスク「${target.title ?? target.text.slice(0, 80)}」${parsed.action === "stop" ? (result.delivery === "stopped" ? "を停止しました。" : "の停止を受け付けました。実行先の停止確認を待っています。") : continuation ? "の続きとして追加依頼を受け付けました。" : "に追加指示を受け付けました。"}`,
        [target.id],
      );
    } catch (error) {
      this.failure(error, "task.control");
      await this.receipt(
        source,
        `${key}:failed`,
        "タスクへの操作を適用できませんでした。最新の状態を確認し、同じタスクから操作してください。",
        [target.id],
      );
    }
  }

  observation(events: CoordinatorEvent[]): CoordinatorObservation {
    this.requireRoutes(events);
    return {
      meetingId: this.meetingId,
      projectId: this.meeting()?.projectId,
      mode: this.audio.mode,
      events: events.map((event) =>
        event.type === "message"
          ? {
              ...event,
              source: {
                ...event.source,
                workAllowed:
                  event.source.workAllowed && this.permitted(event.source),
                researchAllowed:
                  event.source.researchAllowed && this.permitted(event.source),
              },
            }
          : event,
      ),
      activeTasks: this.projectTasks()
        .slice(-12)
        .map((task) => ({
          id: task.id,
          text: task.text.slice(0, 800),
          state: task.state,
          revision: task.revision,
          result: task.result?.slice(0, 800),
          controls: Object.values(task.controlReceipts ?? {})
            .slice(-3)
            .map(({ type, delivery, controlVersion }) => ({
              type,
              delivery,
              controlVersion,
            })),
        })),
      context: this.history(events),
      minutes: this.minutesContext(events),
      participants: new ProjectTeam(this.store)
        .participants(this.meeting()?.projectId ?? "")
        .slice(0, 30)
        .map(({ id, name, context, codexConnected }) => ({
          id,
          name,
          context: context.slice(0, 1000),
          codexConnected,
        })),
    };
  }

  minutesContext(events: CoordinatorEvent[]) {
    const current = new Set(
      events.flatMap((event) =>
        event.type === "message"
          ? [event.source.meetingId ?? this.meetingId]
          : [],
      ),
    );
    const minutes = this.projectMeetings()
      .filter((meeting) => current.has(meeting.id))
      .slice(-3)
      .map((meeting) => ({
        meetingId: meeting.id,
        name: meeting.name,
        markdown: meeting.summary.slice(0, 1500),
        summaryRevision: meeting.summaryRevision ?? 0,
        topics: (meeting.knowledge?.topics ?? []).slice(-12).map((topic) => ({
          ...topic,
          summary: topic.summary.slice(0, 900),
          decisions: topic.decisions.map((text) => text.slice(0, 300)),
          openQuestions: topic.openQuestions.map((text) => text.slice(0, 300)),
          sourceIds: topic.sourceIds.slice(-12),
        })),
      }));
    while (JSON.stringify(minutes).length > 12000) {
      const largest = minutes.toSorted(
        (a, b) => b.topics.length - a.topics.length,
      )[0];
      if (!largest?.topics.length) break;
      largest.topics.shift();
    }
    return minutes;
  }

  history(events: CoordinatorEvent[]) {
    const current = new Set(
      events.flatMap((event) =>
        event.type === "message" ? [event.source.id] : [],
      ),
    );
    const entries = [
      ...this.projectMeetings()
        .flatMap((m) => m.messages)
        .filter(
          (message) =>
            message.stage === "completed" &&
            (message as Message).role !== "assistant" &&
            !current.has(message.id),
        )
        .slice(-30)
        .map((message) => ({
          id: message.id,
          meetingId: (message as Message).meetingId,
          role: "user",
          authorId: message.authorId,
          at: message.at,
          text: message.text.slice(-2000),
        })),
      ...this.store
        .list<{
          meetingId: string;
          text: string;
          at?: number;
          startedAt?: number;
          delivered?: boolean;
          provider?: string;
        }>("conversation-output")
        .filter(
          (output) =>
            (output.at ?? output.startedAt ?? 0) >
              (this.store.get<{ cutoffAt: number }>(
                "project-context",
                this.meeting()?.projectId ?? "",
              )?.cutoffAt ?? -1) &&
            this.projectMeetings().some((m) => m.id === output.meetingId) &&
            (output.delivered || output.provider === "live") &&
            typeof output.text === "string",
        )
        .slice(-30)
        .map((output) => ({
          role: "assistant",
          authorId: "assistant",
          at: output.at ?? output.startedAt ?? 0,
          text: output.text.slice(-2000),
        })),
    ]
      .sort((a, b) => a.at - b.at)
      .slice(-30);
    while (JSON.stringify(entries).length > 12_000) entries.shift();
    return JSON.stringify(entries);
  }

  // Saved inputs retain intent, but a process restart does not recreate the
  // authenticated transport session that authorized their side effects.
  missingRoutes(events: CoordinatorEvent[]) {
    return events.flatMap((event) =>
      event.type === "message" &&
      !this.routes.has(event.source.id) &&
      (event.source.workAllowed ||
        event.source.researchAllowed ||
        event.source.requestReply)
        ? [event.source]
        : [],
    );
  }
  requireRoutes(events: CoordinatorEvent[]) {
    if (this.missingRoutes(events).length)
      throw new Error("COORDINATOR_SOURCE_REVALIDATION_REQUIRED");
  }
  resume(context: InputContext, sourceIds: string[]) {
    if (
      !this.active({
        context,
        event: { eventId: "resume", meetingId: this.meetingId },
      })
    )
      throw new Error("PERMISSION_DENIED");
    const snapshot = this.inbox.snapshot();
    const missing = this.missingRoutes([
      ...(snapshot.active?.events ?? []),
      ...(snapshot.active?.steering ?? []),
      ...snapshot.pending,
    ]);
    const selected = sourceIds.map((id) =>
      missing.find((source) => source.id === id),
    );
    if (
      !selected.length ||
      selected.some(
        (source) =>
          !source ||
          source.authorId !== context.actor.id ||
          this.store.get<{ pluginId: string }>(
            "coordinator-source-route",
            source.id,
          )?.pluginId !== context.pluginId,
      )
    )
      throw new Error("PERMISSION_DENIED");
    for (const source of selected as CoordinatorSource[]) {
      const event: ConversationInput = {
        eventId: `resume-${source.id}`,
        meetingId: source.meetingId ?? this.meetingId,
        projectId: source.projectId,
        text: source.text,
      };
      this.routes.set(source.id, { context, event });
    }
  }

  async segment(
    event: ConversationInput,
    context: InputContext,
    content: string,
    messageId?: string,
  ) {
    const capture = event.capture!;
    const key = `${event.meetingId}:${context.pluginId}:${capture.sessionId}:${capture.utteranceId}`;
    const saved = this.store.get<any>("speech-assembly", key) ?? {
      id: key,
      authorId: context.actor.id,
      parts: {},
    };
    if (saved.authorId !== context.actor.id)
      throw new Error("UTTERANCE_ACTOR_MISMATCH");
    if (saved.parts[capture.segmentIndex]) return false;
    if (capture.segmentIndex < 0 || capture.segmentIndex > 200)
      throw new Error("UTTERANCE_TOO_LONG");
    let message: Message | undefined;
    if (content.trim()) {
      message = this.messages.record(
        event.meetingId,
        context.actor.id,
        content,
        messageId,
      ).message;
      message.capture = capture;
      message.origin = "audio";
      message.at = capture.startedAt;
      message.stage = "assembling";
      this.store.put("message", message.id, message);
    }
    saved.parts[capture.segmentIndex] = {
      ...(message ? { id: message.id, text: content } : {}),
      complete: capture.complete !== false,
      at: capture.startedAt,
    };
    if (capture.final) saved.finalIndex = capture.segmentIndex;
    this.store.put("speech-assembly", key, saved);
    this.publish("transcript", event.meetingId);
    if (saved.finalIndex === undefined) return true;
    const parts = Array.from(
      { length: saved.finalIndex + 1 },
      (_, index) => saved.parts[index],
    );
    if (parts.some((part) => !part)) return true;
    const recognized = parts.filter((part) => part.id && part.text?.trim());
    const text = recognized.map((part) => part.text).join("\n");
    if (!recognized.length) {
      this.store.remove("speech-assembly", key);
      return false;
    }
    // Intermediate pieces are not complete utterances. Only the final marker
    // can declare completeness, after every preceding piece has arrived.
    const complete = parts.at(-1)!.complete && text.length <= 12_000;
    const merged = {
      ...event,
      eventId: `utterance-${stableId(key)}`,
      capture: {
        ...capture,
        startedAt: recognized[0].at,
        segmentIndex: 0,
        complete,
      },
    };
    for (const part of recognized) this.messages.stage(part.id, "queued");
    const accepted = await this.accept(
      merged,
      context,
      complete
        ? text
        : `【不完全な発話。実行指示には使用しない】\n${text.slice(-12_000)}`,
      recognized[0].id,
      recognized.map((part) => part.id),
    );
    this.store.remove("speech-assembly", key);
    return accepted;
  }

  async accept(
    event: ConversationInput,
    context: InputContext,
    content: string,
    messageId?: string,
    partIds?: string[],
  ) {
    if (this.closed || !context.valid()) return false;
    const inputId = `${context.pluginId}:${event.eventId}`;
    const id = messageId || stableId(inputId);
    const route = { event, context };
    this.routes.set(id, route);
    this.lastRoute = route;
    if (this.routes.size > 1000)
      this.routes.delete(this.routes.keys().next().value!);
    const record = this.messages.record(
      event.meetingId,
      context.actor.id,
      partIds
        ? (this.store.get<Message>("message", id)?.text ?? content)
        : content,
      id,
    ).message;
    if (partIds) this.store.put("speech-sources", id, { partIds });
    record.role = "user";
    record.origin = event.audio ? "audio" : "text";
    record.inputId ??= inputId;
    record.command = event.command;
    if (!partIds) record.capture = event.capture;
    record.complete = event.capture?.complete !== false;
    record.at = record.capture?.startedAt ?? record.at;
    record.stage = "queued";
    record.steps = {
      ...record.steps,
      transcription: { state: event.audio ? "completed" : "skipped" },
      minutes: { state: "pending" },
      reply: { state: "pending" },
      delivery: { state: "pending" },
    };
    this.store.put("message", id, record);
    this.store.put("coordinator-source-route", id, {
      pluginId: context.pluginId,
    });
    // Raw statements are already durable. Topic minutes are updated by the
    // coordinator response; MinutesDocument owns the editable Markdown.
    this.publish("transcript", event.meetingId);
    const addressed =
      event.interaction === true ||
      event.command === "ask" ||
      event.command === "task" ||
      event.command === "stop" ||
      event.command === "steer" ||
      Boolean(parseBotInvocation(content));
    const canWork =
      context.actor.role !== "viewer" &&
      Boolean(event.projectId) &&
      record.complete !== false;
    const source: CoordinatorSource = {
      meetingId: event.meetingId,
      id,
      authorId: record.authorId,
      authorName: record.authorName,
      text: content,
      at: record.at,
      origin: record.origin,
      complete: record.complete,
      command: event.command as CoordinatorSource["command"],
      projectId: event.projectId,
      requestReply: addressed,
      direct: event.interaction === true,
      workAllowed: canWork && event.command !== "ask",
      researchAllowed: canWork && (addressed || proactiveOpportunity(content)),
    };
    this.audio.observeMessage({ ...record, meetingId: event.meetingId });
    if (event.audio) await this.audio.handleMedia(event, context);
    // Explicit task commands retain their exact intent and retry key. Normal
    // speech is interpreted only by the main model through sourced proposals.
    if (event.command === "task" && canWork && this.active(route)) {
      const task = this.options.work.submit({
        sourcePluginId: context.pluginId,
        requestKey: inputId,
        meetingId: event.meetingId,
        projectId: event.projectId!,
        authorId: context.actor.id,
        request: content,
        sourceIds: [id],
        kind: "implementation",
        trigger: "requested",
      });
      source.workAllowed = false;
      source.researchAllowed = false;
      source.handled = true;
      await this.receipt(
        source,
        inputId,
        `タスク「${task.title ?? task.text.slice(0, 100)}」を受け付けました。進捗・追加指示は同じタスクで確認できます。`,
        [task.id],
      );
    }
    const control = taskControl(content);
    if (control && canWork && !source.handled && this.active(route)) {
      const candidates = this.controlCandidates(source, control);
      source.handled = true;
      source.workAllowed = false;
      source.researchAllowed = false;
      if (candidates.length === 1)
        await this.applyControl(
          source,
          candidates[0],
          control,
          `direct-control:${inputId}`,
        );
      else
        await this.receipt(
          source,
          `control-target:${inputId}`,
          candidates.length
            ? "対象のタスクが複数あります。タスク画面から選ぶか、タスクIDを指定してください。"
            : "操作できる対象のタスクが見つかりませんでした。タスク画面で対象と状態を確認してください。",
          candidates.map((task) => task.id),
        );
    }
    await this.inbox.submit(
      [
        {
          id: inputId,
          type: "message",
          source,
          priority: event.priority ?? (addressed ? "immediate" : "normal"),
        },
      ],
      {
        urgent:
          event.priority === "immediate" ||
          (event.priority !== "normal" && addressed),
      },
    );
    return true;
  }

  async setMode(mode: ConversationMode) {
    await this.audio.setMode(mode);
    this.modeRevision++;
    this.save();
  }
  async media(event: ConversationInput, context: InputContext) {
    if (!context.valid() || this.closed) return;
    this.lastRoute = { event, context };
    await this.audio.handleMedia(event, context);
  }
  async assistant(event: any) {
    if (this.closed) return;
    const id = `live:${event.id}`;
    if (this.store.get("conversation-output", id)) return;
    this.store.put("conversation-output", id, {
      ...event,
      id,
      meetingId: this.lastRoute?.event.meetingId ?? this.meetingId,
      role: "assistant",
      provider: "live",
      taskIds: this.projectTasks().map((task) => task.id),
      playbackStatus: "unknown",
    });
    await this.inbox.submit([
      {
        id,
        type: "assistant_output",
        text: String(event.text ?? ""),
        provider: "live",
        at: event.startedAt ?? Date.now(),
      },
    ]);
  }
  async attention(event: any) {
    const sourceIds = event.sourceIds ?? [];
    if (!sourceIds.length || this.closed) return;
    await this.inbox.submit(
      [
        {
          id: `attention:${event.delegation?.id ?? event.id}`,
          type: "attention",
          sourceIds,
        },
      ],
      { urgent: true },
    );
  }
  async result(result: WorkResult) {
    if (result.superseded || this.closed) return;
    const event: CoordinatorEvent = {
      id: `result:${result.id}:${result.runId}:${result.runRevision}`,
      type: "task_result",
      meetingId: result.meetingId,
      taskId: result.id,
      revision: result.runRevision,
      text: result.result.slice(0, 8000),
      sourceIds: result.sourceIds ?? [],
      superseded: result.superseded,
    };
    await this.inbox.submit([event], { start: true });
  }

  private updateMinutes(meetingId: string) {
    void this.options
      .updateMinutes?.(meetingId)
      .then(() => {
        if (!this.closed) this.publish("minutes", meetingId);
      })
      .catch((error) => {
        if (!this.closed)
          this.store.logError(error, {
            source: "meeting",
            operation: "minutes.generate",
            meetingId,
          });
      });
  }
  private async apply(value: ModelValue, batch: Batch) {
    if (
      this.completed.has(batch.id) ||
      this.closed ||
      this.store.get("project-lock", this.meeting()?.projectId ?? "")
    )
      return;
    this.requireRoutes(batch.events);
    const response = { ...value.response };
    const speechEvents = batch.events.filter(
      (event) => event.type === "speech_review",
    );
    for (const event of speechEvents) {
      const decision = response.speech;
      this.speechReviews.get(event.id)?.(
        value.modeRevision === this.modeRevision &&
          decision?.candidateId === event.review.candidateId &&
          decision.revision === event.review.revision
          ? decision
          : undefined,
      );
    }
    const sources = batch.events.flatMap((event) =>
      event.type === "message" ? [event.source] : [],
    );
    const allowed = new Set(sources.map((source) => source.id));
    const application: TaskApplication = this.store.get(
      "coordinator-trace",
      `application:${batch.id}`,
    ) ?? {
      id: `application:${batch.id}`,
      kind: "application",
      batchId: batch.id,
      meetingId: this.meetingId,
      projectId: this.meeting()?.projectId,
      at: Date.now(),
      sourceIds: [...allowed],
      initialResponse: value.response,
      rejections: response.tasks.flatMap((task, index) => {
        const reason = sourceRejection(task, allowed);
        return reason ? [{ index, task, reason }] : [];
      }),
      decisions: [],
    };
    const saveApplication = () =>
      this.store.put("coordinator-trace", application.id, application);
    saveApplication();
    if (application.rejections.length) {
      if (
        !application.repair &&
        sources.some(
          (source) =>
            this.permitted(source) &&
            !source.handled &&
            !source.contextOnly &&
            source.complete !== false &&
            (source.workAllowed || source.researchAllowed),
        )
      ) {
        const runtime = await this.inbox.runtime();
        if (
          this.closed ||
          this.store.get("project-lock", this.meeting()?.projectId ?? "")
        )
          return;
        const observation = this.observation(batch.events);
        observation.taskValidation = {
          allowedSourceIds: [...allowed],
          rejectedTasks: application.rejections,
        };
        // Persist before sending; a restart or unknown delivery must never
        // turn a single correction into an unbounded sequence of model calls.
        application.repair = { status: "sending" };
        saveApplication();
        try {
          const corrected = await runtime.run(observation, {
            signal: this.inbox.controller.signal,
          });
          application.repair = { status: "completed", value: corrected };
        } catch (error) {
          application.repair = {
            status: "failed",
            error: describeError(error),
          };
          this.store.logError(error, {
            source: "conversation",
            operation: "coordinator.task-correction",
            meetingId: this.meetingId,
            eventId: batch.id,
            level: "warning",
          });
        }
        saveApplication();
      }
      // Keep valid original proposals, and accept only tasks from correction.
      // Reply, controls and minutes retain their original validation versions.
      response.tasks = [
        ...response.tasks.filter((task) => !sourceRejection(task, allowed)),
        ...(application.repair?.value?.response.tasks ?? []),
      ];
    }
    if (
      this.closed ||
      this.store.get("project-lock", this.meeting()?.projectId ?? "")
    )
      return;
    this.requireRoutes(batch.events);
    const select = (ids: string[]) =>
      ids
        .map((id) => sources.find((source) => source.id === id))
        .filter((source): source is CoordinatorSource => !!source);
    const knownSources = new Set(
      this.projectMeetings().flatMap((meeting) =>
        meeting.messages.map((message) => message.id),
      ),
    );
    const minutes = new MeetingKnowledgeStore(this.store);
    for (const update of response.minutes ?? []) {
      if (
        sources.some(
          (source) =>
            (source.meetingId ?? this.meetingId) === update.meetingId &&
            this.active(this.routes.get(source.id)),
        ) &&
        minutes.apply(this.meeting()?.projectId ?? "", update, knownSources)
      ) {
        this.publish("minutes", update.meetingId);
        // The Markdown writer owns the minutes processing status.
      }
    }
    let automaticStarted = 0;
    const receipts = new Set<string>();
    for (const [index, task] of response.tasks.entries()) {
      const decision = (reason: string, taskId?: string) => {
        application.decisions = application.decisions.filter(
          (item) => item.index !== index,
        );
        application.decisions.push({ index, task, reason, taskId });
        saveApplication();
      };
      const selected = select(task.sourceIds);
      const rejection =
        sourceRejection(task, allowed) ??
        (selected.some((source) => !this.active(this.routes.get(source.id)))
          ? "inactive_source"
          : selected.some((source) => source.complete === false)
            ? "incomplete_source"
            : selected.some((source) => source.handled)
              ? "already_handled"
              : selected.some((source) => source.contextOnly)
                ? "context_only_source"
                : undefined);
      if (rejection) {
        decision(rejection);
        continue;
      }
      const research = task.kind === "research";
      const eligible = selected.filter(
        (source) =>
          this.permitted(source) &&
          (research ? source.researchAllowed : source.workAllowed),
      );
      const requested = eligible.findLast(
        (source) =>
          (research && source.requestReply) ||
          explicitDelegation(source.text, {
            explicitlyAsked:
              source.command === "task" || source.direct === true,
          }),
      );
      const automatic = !requested;
      const author =
        requested ??
        eligible.findLast((source) => proactiveOpportunity(source.text));
      if (
        !author ||
        selected.some((source) => deferredDelegation(source.text))
      ) {
        decision(
          !eligible.length
            ? "permission_denied"
            : selected.some((source) => deferredDelegation(source.text))
              ? "deferred"
              : "no_current_intent",
        );
        continue;
      }
      if (
        !author.projectId ||
        !selected.every((source) => source.projectId === author.projectId)
      ) {
        decision("project_mismatch");
        continue;
      }
      const existingTasks = this.projectTasks();
      const requestKey = `coordinator:${this.meetingId}:${stableId(task.sourceIds.slice().sort().join(","))}:${index}`;
      const previous = this.options.work.getReceipt({
        requestKey,
        authorId: author.authorId,
        projectId: author.projectId,
      });
      const duplicate = previous
        ? undefined
        : duplicateWork(existingTasks, task.title, automatic);
      if (duplicate) {
        decision("duplicate_task", duplicate.id);
        if (author.requestReply) {
          await this.receipt(
            author,
            `duplicate:${batch.id}:${duplicate.id}`,
            `同じ目的のタスク「${duplicate.title ?? duplicate.text.slice(0, 100)}」が既にあります。進捗と追加指示はそのタスクで確認できます。`,
            [duplicate.id],
          );
          receipts.add(author.id);
        }
        continue;
      }
      if (
        !previous &&
        automatic &&
        (automaticStarted >= 1 ||
          existingTasks.filter(
            (existing) =>
              existing.trigger === "proactive" &&
              ["queued", "assigned", "running", "interrupted"].includes(
                existing.state,
              ),
          ).length >= 2 ||
          existingTasks.some(
            (existing) =>
              existing.trigger === "proactive" &&
              Date.now() - existing.createdAt < 45_000,
          ))
      ) {
        decision("proactive_limit");
        continue;
      }
      decision("submitting");
      let created: Task;
      try {
        created =
          previous ??
          this.options.work.submit({
            sourcePluginId: this.routes.get(author.id)?.context.pluginId,
            requestKey,
            meetingId: author.meetingId ?? this.meetingId,
            projectId: author.projectId,
            authorId: author.authorId,
            title: task.title,
            request: [
              `担当範囲: ${task.title}`,
              ...task.acceptanceCriteria.map(
                (criterion) => `完了条件: ${criterion}`,
              ),
              "利用者の元発言:",
              ...selected.map((source) => source.text),
            ].join("\n"),
            kind: task.kind,
            trigger: automatic ? "proactive" : "requested",
            sourceStatements: selected.map((source) => ({
              id: source.id,
              meetingId: source.meetingId ?? this.meetingId,
              authorId: source.authorId,
              speakerName: source.authorName,
              startedAt: source.at,
              text: source.text,
            })),
            sourceIds: task.sourceIds,
            executionPolicy: research
              ? { sandboxMode: "read-only" }
              : undefined,
          });
      } catch (error) {
        decision("submission_failed");
        throw error;
      }
      decision("accepted", created.id);
      if (automatic) automaticStarted++;
      await this.receipt(
        author,
        `work:${batch.id}:${created.id}`,
        `${automatic ? "会議の確認を進めるため、" : ""}タスク「${created.title ?? task.title}」を受け付けました。${created.state === "queued" ? "実行先の空き・許可を待っています。" : "進捗は同じタスクで確認できます。"}`,
        [created.id],
      );
      for (const source of selected) receipts.add(source.id);
    }
    for (const meetingId of new Set(
      sources.map((source) => source.meetingId ?? this.meetingId),
    ))
      this.updateMinutes(meetingId);
    for (const control of response.controls) {
      const selected = select(control.sourceIds);
      if (
        !selected.length ||
        selected.length !== control.sourceIds.length ||
        !selected.every(
          (source) => this.permitted(source) && source.workAllowed,
        )
      )
        continue;
      const target = this.projectTasks().find(
        (task) => task.id === control.taskId,
      );
      if (
        !target ||
        !selected.every((source) => source.projectId === target.projectId)
      )
        continue;
      const author = selected.findLast((source) => {
        const parsed = taskControl(source.text);
        if (
          !parsed ||
          (parsed.action === "stop" ? "stop" : "instruction") !== control.type
        )
          return false;
        const candidates = this.controlCandidates(source, parsed);
        return candidates.length === 1 && candidates[0].id === target.id;
      });
      if (!author) continue;
      await this.applyControl(
        author,
        target,
        taskControl(author.text)!,
        `coordinator:${batch.id}:${control.type}:${target.id}`,
        value.controlVersions[target.id],
      );
      receipts.add(author.id);
    }
    const unresolvedCorrection =
      application.rejections.length > 0 &&
      (!application.repair?.value?.response.tasks.length ||
        application.decisions.some(
          (item) => !["accepted", "duplicate_task"].includes(item.reason),
        ));
    for (const source of sources) {
      if (
        (source.requestReply || explicitDelegation(source.text)) &&
        !source.handled &&
        (!receipts.has(source.id) || unresolvedCorrection) &&
        (application.rejections.length > 0 ||
          response.tasks.some((task) => task.sourceIds.includes(source.id)) ||
          response.controls.some((control) =>
            control.sourceIds.includes(source.id),
          ))
      ) {
        await this.receipt(
          source,
          `not-applied:${batch.id}:${source.id}`,
          receipts.has(source.id)
            ? "一部のタスク案を今回の依頼と対応づけられず、登録できませんでした。未登録の作業について、対象と今進める内容を教えてください。"
            : "この発言からはタスクを開始・変更していません。対象と、今進める具体的な作業を教えてください。",
          [],
        );
        receipts.add(source.id);
      }
    }
    const answer = response.reply;
    let replyApplied = false;
    if (answer && value.modeRevision === this.modeRevision) {
      const selected = select(answer.sourceIds);
      const results = batch.events.filter(
        (event) => event.type === "task_result",
      );
      const resultEvent =
        results.length > 0 &&
        results.every((event) => {
          const current = this.options.work.getResult(event.taskId);
          return (
            !event.superseded &&
            current &&
            !current.superseded &&
            current.runRevision === event.revision &&
            event.id ===
              `result:${current.id}:${current.runId}:${current.runRevision}`
          );
        });
      const allowed =
        !response.tasks.length &&
        !response.controls.length &&
        !selected.some((source) => source.handled || receipts.has(source.id)) &&
        (!results.length || resultEvent) &&
        (resultEvent ||
          (selected.length === answer.sourceIds.length &&
            selected.length > 0 &&
            selected.every((source) =>
              this.active(this.routes.get(source.id)),
            ) &&
            (selected.some((source) => source.requestReply) ||
              answer.reason !== "direct_answer")));
      const directLiveVoice =
        this.audio.mode === "live" &&
        answer.reason === "direct_answer" &&
        selected.every((source) => source.origin === "audio") &&
        !resultEvent;
      if (allowed && !directLiveVoice) {
        replyApplied = true;
        const outputId = `reply:${batch.id}`;
        const previous = this.store.get<any>("conversation-output", outputId);
        const output = previous ?? {
          id: outputId,
          meetingId:
            selected.at(-1)?.meetingId ??
            results.at(-1)?.meetingId ??
            this.meetingId,
          role: "assistant",
          taskIds: [
            ...new Set([
              ...Object.keys(value.controlVersions),
              ...batch.events.flatMap((event) =>
                event.type === "task_result" ? [event.taskId] : [],
              ),
            ]),
          ],
          provider: "coordinator",
          text: answer.text,
          sourceIds: answer.sourceIds,
          at: Date.now(),
          delivered: false,
          playbackStatus: "not_confirmed",
        };
        this.store.put("conversation-output", outputId, output);
        for (const source of selected)
          this.messages.response(source.id, answer.text);
        const route =
          selected
            .map((source) => this.routes.get(source.id))
            .find((candidate) => this.active(candidate)) ??
          (this.active(this.lastRoute) ? this.lastRoute : undefined);
        if (!output.delivered && !output.deliveryStatus && route) {
          // The plugin RPC can time out after sending. Persist the attempt first
          // and never resend it automatically from a saved model response.
          output.deliveryStatus = "unknown";
          this.store.put("conversation-output", outputId, output);
          try {
            await route.context.deliver({
              kind: "reply",
              eventId: outputId,
              content: answer.text,
              replyTo: route.event.replyTo,
            });
            output.delivered = true;
            output.deliveryStatus = "delivered";
            this.store.put("conversation-output", outputId, output);
          } catch (error) {
            this.failure(error, "conversation.deliver");
          }
        }
        if (
          !output.audioRequested &&
          !speechEvents.length &&
          value.modeRevision === this.modeRevision &&
          (resultEvent || selected.some((source) => source.origin === "audio"))
        ) {
          output.audioRequested = true;
          this.store.put("conversation-output", outputId, output);
          void this.audio
            .reply(
              {
                text: answer.text,
                contextRevision: value.audioRevision,
                replyTo: route?.event.replyTo,
                sourceIds: answer.sourceIds,
                reason:
                  resultEvent || this.audio.mode === "live"
                    ? "backend"
                    : "direct",
                events: batch.events,
              },
              route?.context,
            )
            .catch((error) => this.failure(error, "audio.reply"));
        }
        for (const source of selected)
          this.messages.step(
            source.id,
            "delivery",
            output.delivered ? "completed" : "interrupted",
          );
      }
    }
    for (const source of sources) {
      const ids = this.store.get<{ partIds: string[] }>(
        "speech-sources",
        source.id,
      )?.partIds ?? [source.id];
      for (const id of ids) {
        this.messages.stage(id, "completed");
        this.messages.step(id, "reply", replyApplied ? "completed" : "skipped");
        const message = this.store.get<Message>("message", id);
        if (message?.inputId) {
          const input = this.store.get<Record<string, unknown>>(
            "input",
            message.inputId,
          );
          if (input)
            this.store.put("input", message.inputId, {
              ...input,
              stage: "completed",
              messageId: id,
            });
        }
      }
    }
    this.completed.add(batch.id);
    application.completedAt = Date.now();
    saveApplication();
    this.save();
    this.publish("transcript");
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    for (const settle of this.speechReviews.values()) settle();
    await this.inbox.close();
    await this.audio.close();
    this.save();
  }
}

export class CoordinatedConversation {
  readonly sessions = new Map<string, MeetingCoordinator>();
  private closed = false;
  constructor(
    readonly store: Repository,
    readonly options: CoordinatedOptions,
  ) {}
  session(meetingId: string) {
    if (this.closed) throw new Error("COORDINATOR_CLOSED");
    const meeting = this.store.get<Meeting>("meeting", meetingId);
    if (!meeting) throw new Error("MEETING_NOT_FOUND");
    if (meeting.projectId && this.store.get("project-lock", meeting.projectId))
      throw new Error("WORKSPACE_CONFLICT");
    const saved = meeting.projectId
      ? this.store.get<{ coordinatorId: string }>(
          "project-conversation",
          meeting.projectId,
        )
      : undefined;
    const coordinatorId = saved?.coordinatorId ?? meetingId;
    if (meeting.projectId && !saved)
      this.store.put("project-conversation", meeting.projectId, {
        projectId: meeting.projectId,
        meetingId,
        coordinatorId,
      });
    let session = this.sessions.get(coordinatorId);
    if (!session) {
      session = new MeetingCoordinator(this.store, coordinatorId, this.options);
      this.sessions.set(coordinatorId, session);
    }
    return session;
  }
  accept(
    event: ConversationInput,
    context: InputContext,
    content: string,
    messageId?: string,
  ) {
    return event.audio && event.capture
      ? this.session(event.meetingId).segment(
          event,
          context,
          content,
          messageId,
        )
      : this.session(event.meetingId).accept(
          event,
          context,
          content,
          messageId,
        );
  }
  transcription(
    event: ConversationInput,
    context: InputContext,
    active: boolean,
  ) {
    return this.session(event.meetingId).audio.transcription(
      event,
      context,
      active,
    );
  }
  handleMedia(event: ConversationInput, context: InputContext) {
    return this.session(event.meetingId).media(event, context);
  }
  setMode(meetingId: string, mode: ConversationMode) {
    return this.session(meetingId).setMode(mode);
  }
  flush(meetingId: string) {
    return this.session(meetingId).inbox.flush();
  }
  async taskEvents(
    tasks: Array<{ id: string; state: string; meetingId: string }>,
  ) {
    for (const task of tasks) {
      if (this.closed) return;
      if (
        !this.sessions.has(task.meetingId) &&
        !this.store.get("coordinator", task.meetingId) &&
        !this.store.get(
          "project-conversation",
          this.store.get<Meeting>("meeting", task.meetingId)?.projectId ?? "",
        )
      )
        continue;
      if (!["completed", "failed"].includes(task.state)) continue;
      const result = this.options.work.getResult(task.id);
      if (result) await this.session(task.meetingId).result(result);
    }
  }
  state(meetingId: string) {
    const session = this.session(meetingId);
    const state = session.inbox.snapshot();
    return {
      mode: session.audio.mode,
      busy: session.inbox.busy,
      uncertain: session.inbox.uncertain,
      pending: state.pending.length,
      status: state.active?.status,
      batchId: state.active?.id ?? state.pending[0]?.id,
      awaitingSources: session
        .missingRoutes([
          ...(state.active?.events ?? []),
          ...(state.active?.steering ?? []),
          ...state.pending,
        ])
        .map((source) => ({ id: source.id, authorId: source.authorId })),
    };
  }
  async resume(meetingId: string, context: InputContext, sourceIds: string[]) {
    const session = this.session(meetingId);
    session.resume(context, sourceIds);
    return session.inbox.flush();
  }
  async resolve(meetingId: string, retry: boolean) {
    const session = this.session(meetingId);
    await session.inbox.resolveUncertain({ retry });
    return session.inbox.flush();
  }
  async resetProject(projectId: string) {
    const meetings = this.store
      .list<Meeting>("meeting")
      .filter((m) => m.projectId === projectId);
    for (const meeting of meetings) {
      const session = this.sessions.get(meeting.id);
      if (session) {
        await session.close();
        this.sessions.delete(meeting.id);
      }
    }
  }
  async close() {
    this.closed = true;
    await Promise.all(
      [...this.sessions.values()].map((session) => session.close()),
    );
  }
}
