import { VOICE_TIMING } from "@ido/common/runtime/audio-signal";
import type {
  SpeechReview,
  SpeechDecision,
} from "@ido/common/contracts/coordinator";
import { SpeechTurns, type SpeechCandidate } from "./turns.js";
import { randomUUID } from "node:crypto";
import type {
  ConversationInput,
  ConversationModeKind,
  InputContext,
  PluginOutput,
} from "@ido/common/contracts/plugins";
import {
  createConversationModeController,
  createLiveConversationMode,
  createTextSpeechConversationMode,
} from "../../processing/conversation-mode.mjs";
import { createSpeechController } from "./controller.mjs";

interface LiveSession {
  ready?: boolean;
  meetingId?: string;
  start(): Promise<void>;
  input(subject: string, pcm: Buffer): void;
  speakerStart(subject: string): void;
  speakerEnd(subject: string): void;
  recordStatement(statement: Record<string, unknown>): void;
  commentary(text: string): void;
  silence(): void;
  resume(): void;
  close(reason?: string): void;
}
export interface AudioMessage {
  id: string;
  meetingId: string;
  authorId: string;
  authorName?: string;
  text: string;
  at: number;
  capture?: ConversationInput["capture"];
  sequence?: number;
}
export interface ConversationAudioOptions {
  mode?: ConversationModeKind;
  reviewSpeech?(
    review: SpeechReview,
    signal: AbortSignal,
  ): Promise<SpeechDecision | null | undefined>;
  onSpeechState?(id: string, state: string): void;
  createLiveSession?: (options: Record<string, any>) => Promise<LiveSession>;
  synthesize(text: string): Promise<string>;
  currentResults?(): Array<{
    id: string;
    runRevision: number;
    superseded: boolean;
  }>;
  recordAssistant(event: Record<string, any>): void | Promise<void>;
  onDelegation(event: Record<string, any>): void | Promise<void>;
  onError?(error: unknown): void;
}

// Owns the selected audio conversation implementation, not authorization or
// durable meeting state. Every delivery uses a still-valid plugin context.
export class ConversationAudio {
  private desiredMode: ConversationModeKind;
  private voice?: { event: ConversationInput; context: InputContext };
  private sessionId?: string;
  private messageSequence = 0;
  private speakers = new Set<string>();
  private utterances = new Map<string, string>();
  private endedUtterances = new Set<string>();
  private quietUntil = 0;
  private liveSuppressed = false;
  readonly turns: SpeechTurns;
  private pendingTranscriptions = new Map<string, string | undefined>();
  private completedTranscriptions = new Set<string>();
  private retiredSessions = new Set<string>();
  private frameSequences = new Map<string, number>();
  private recentMessages: AudioMessage[] = [];
  private live?: LiveSession;
  private starting?: Promise<void>;
  private switching = Promise.resolve();
  private closed = false;
  private audioVersion = 0;
  private quietRevision = -1;
  private candidateId: string = randomUUID();
  private outputSequence = 0;
  private pendingFrames = 0;
  private shutdown = new AbortController();
  private speech: ReturnType<typeof createSpeechController>;
  private modes: ReturnType<typeof createConversationModeController>;

  constructor(readonly options: ConversationAudioOptions) {
    this.desiredMode = options.mode ?? "text-speech";
    this.turns = new SpeechTurns({
      valid: () => !this.closed && !!this.voice?.context.valid(),
      ready: () => !this.speakers.size && !this.pendingTranscriptions.size,
      quietUntil: () => this.quietUntil,
      conversation: () =>
        this.recentMessages
          .map(({ id, authorId, text }) => ({
            id,
            authorId,
            text: text.slice(0, 600),
          }))
          .slice(-12),
      resultsValid: (candidate) => this.resultsValid(candidate),
      review: options.reviewSpeech,
      stop: () => this.interruptOutput(),
      replace: (candidate) => {
        void this.launch(candidate).catch((error) => this.report(error));
      },
      state: options.onSpeechState,
      error: (error) => this.report(error),
    });
    this.speech = createSpeechController({
      getState: () => ({
        meetingId: this.voice?.event.meetingId,
        modeRevision: this.modes?.revision ?? 0,
        enabled: Boolean(this.voice?.context.valid()),
        closed: this.closed,
        paused: false,
        revision: this.turns.revision,
        pendingTranscripts:
          this.speakers.size +
          this.pendingTranscriptions.size +
          Number(Date.now() < this.quietUntil || this.turns.blocked),
        conversation: this.recentMessages.map((message) => ({
          role: "user",
          text: message.text,
          sequence: message.sequence,
        })),
        results: options.currentResults?.() ?? [],
      }),
      synthesize: (text: string) => options.synthesize(text),
      playAudio: (audio: string, playback: any) => this.play(audio, playback),
      validate: undefined,
      signal: this.shutdown.signal,
      onValidated: undefined,
      onError: (error: unknown) => {
        if (this.turns.candidate?.state === "queued") this.turns.discard();
        this.report(error);
      },
    });
    const textSpeech = createTextSpeechConversationMode({
      enqueueSpeech: (reply: any) => {
        if (reply.candidateId !== this.turns.candidate?.id)
          return Promise.resolve();
        return this.speech.enqueue({
          ...reply,
          meetingId: this.voice?.event.meetingId,
          modeRevision: this.modes.revision,
        });
      },
      stopSpeech: async () => {
        this.speech.cancel();
        await this.stopOutput();
        await this.speech.idle();
      },
    });
    this.modes = createConversationModeController({ textSpeech });
  }
  private resultsValid(candidate: SpeechCandidate) {
    const results = this.options.currentResults?.() ?? [];
    return candidate.targets.every(
      (target) =>
        !target.resultId ||
        results.some(
          (result) =>
            result.id === target.resultId &&
            result.runRevision === target.runRevision &&
            !result.superseded,
        ),
    );
  }
  private async interruptOutput(reason = "speech-interrupted") {
    this.speech.cancel();
    // Increment before close: old callbacks must never affect the replacement.
    if (this.desiredMode === "live") {
      this.audioVersion++;
      this.liveSuppressed = true;
      this.live?.close(reason);
      this.live = undefined;
    }
    await this.stopOutput();
  }
  private async launch(candidate: SpeechCandidate) {
    if (this.turns.candidate !== candidate) return;
    if (this.desiredMode === "live") {
      await this.ensureLive();
      if (this.turns.candidate !== candidate) return;
      if (this.desiredMode === "live") {
        // Only an approved, quiet candidate may instruct the new Live session.
        if (!this.turns.canStart(candidate)) {
          candidate.needsReview = true;
          this.turns.wake();
          return;
        }
        this.liveSuppressed = false;
      }
    }
    const result = await this.modes.routeReply(
      {
        text: candidate.text,
        targets: candidate.targets,
        candidateId: candidate.id,
      },
      { modeRevision: this.modes.revision },
    );
    if (
      this.desiredMode === "text-speech" &&
      this.turns.candidate === candidate &&
      candidate.state === "queued"
    )
      this.turns.discard();
    return result;
  }
  get mode() {
    return this.desiredMode;
  }
  private report(error: unknown) {
    if (
      error instanceof Error &&
      ["AUDIO_PLAYBACK_INTERRUPTED", "AUDIO_PLAYBACK_DISCARDED"].includes(
        error.message,
      )
    )
      return;
    try {
      this.options.onError?.(error);
    } catch {
      /* observer */
    }
  }
  private async deliver(output: Omit<PluginOutput, "replyTo">) {
    const voice = this.voice;
    if (!voice?.context.valid() || this.closed) return;
    await voice.context.deliver({ ...output, replyTo: voice.event.replyTo });
  }
  private async stopOutput() {
    const candidateId = this.candidateId;
    this.candidateId = randomUUID();
    this.outputSequence = 0;
    await this.deliver({
      kind: "audio-stop",
      eventId: candidateId,
      candidateId,
    });
  }
  private async play(audio: string, playback: any) {
    const candidate = this.turns.candidate;
    if (!candidate) return;
    // Human activity may arrive after the ticket was checked but before play.
    while (
      this.turns.candidate === candidate &&
      (!playback.canStart() || !this.turns.canStart(candidate))
    ) {
      if (!(await playback.beforeStart({ signal: playback.signal }))) return;
    }
    if (this.turns.candidate !== candidate) return;
    const candidateId = (this.candidateId = candidate.id);
    this.turns.playing(candidate);
    const cancel = () => {
      void this.deliver({
        kind: "audio-stop",
        eventId: candidateId,
        candidateId,
      }).catch((error) => this.report(error));
    };
    playback.signal?.addEventListener("abort", cancel, { once: true });
    try {
      await this.deliver({
        kind: "audio",
        eventId: candidateId,
        candidateId,
        audio,
        audioFormat: "ogg-opus",
      });
      this.turns.completed(candidate);
    } catch (error) {
      if (this.turns.candidate === candidate && candidate.state === "playing") {
        if (
          error instanceof Error &&
          ["AUDIO_PLAYBACK_INTERRUPTED", "AUDIO_PLAYBACK_DISCARDED"].includes(
            error.message,
          )
        )
          await this.turns.interrupt();
        else this.turns.discard();
      }
      throw error;
    } finally {
      playback.signal?.removeEventListener("abort", cancel);
    }
  }
  private append(pcm: Buffer) {
    if (
      this.closed ||
      this.pendingFrames >= 32 ||
      this.liveSuppressed ||
      !this.voice?.context.valid()
    )
      return;
    let candidate = this.turns.candidate;
    if (!candidate)
      candidate = this.turns.offer({
        text: "",
        sourceIds: this.recentMessages.slice(-4).map((m) => m.id),
        targets: [],
        provider: "live",
      });
    if (candidate.state !== "playing") {
      if (!this.turns.canStart(candidate)) {
        candidate.needsReview = true;
        this.liveSuppressed = true;
        this.turns.wake();
        return;
      }
      this.candidateId = candidate.id;
      this.turns.playing(candidate);
    }
    for (let offset = 0; offset < pcm.length; offset += 9600) {
      if (this.pendingFrames >= 32) return;
      this.pendingFrames++;
      void this.deliver({
        kind: "audio-frame",
        eventId: `${this.candidateId}:${this.outputSequence}`,
        candidateId: this.candidateId,
        audio: pcm.subarray(offset, offset + 9600).toString("base64"),
        audioFormat: "pcm16-24000-mono",
        audioSequence: this.outputSequence++,
      })
        .catch((error) => this.report(error))
        .finally(() => this.pendingFrames--);
    }
  }
  private ensureLive(): Promise<void> {
    if (this.live?.ready || this.closed || this.desiredMode !== "live")
      return Promise.resolve();
    if (this.starting) return this.starting.then(() => this.ensureLive());
    const sessionId = this.sessionId;
    const version = this.audioVersion;
    const starting = (async () => {
      if (!this.options.createLiveSession)
        throw new Error("LIVE_NOT_CONFIGURED");
      const live = await this.options.createLiveSession({
        output: {
          append: (pcm: Buffer) => {
            if (version === this.audioVersion) this.append(pcm);
          },
          clear: () => {
            if (version === this.audioVersion)
              void this.stopOutput().catch((error) => this.report(error));
          },
          close: () => {
            if (version === this.audioVersion)
              void this.stopOutput().catch((error) => this.report(error));
          },
        },
        onAssistantTranscript: (event: Record<string, any>) => {
          if (version === this.audioVersion && this.voice?.context.valid()) {
            let candidate = this.turns.candidate;
            if (!candidate && !this.liveSuppressed)
              candidate = this.turns.offer({
                text: "",
                sourceIds: this.recentMessages.slice(-4).map((m) => m.id),
                targets: [],
                provider: "live",
              });
            if (
              candidate?.provider === "live" &&
              candidate.state !== "interrupted"
            )
              candidate.generatedText = (
                (candidate.generatedText ?? "") + String(event.text ?? "")
              ).slice(-8000);
            return this.options.recordAssistant({
              ...event,
              meetingId: this.voice?.event.meetingId,
              playbackSuppressedAtReceipt:
                this.liveSuppressed || event.playbackSuppressedAtReceipt,
            });
          }
        },
        onDelegation: (event: Record<string, any>) => {
          if (version === this.audioVersion && this.voice?.context.valid())
            return this.options.onDelegation(event);
        },
        onFailure: () => {
          if (version !== this.audioVersion) return;
          this.report(new Error("LIVE_SESSION_FAILED"));
          void this.setMode("text-speech").catch((error) => this.report(error));
        },
      });
      if (
        this.closed ||
        this.desiredMode !== "live" ||
        sessionId !== this.sessionId ||
        version !== this.audioVersion
      ) {
        live.close();
        return;
      }
      this.live = live;
      live.meetingId = this.voice?.event.meetingId;
      await live.start();
      if (
        this.closed ||
        this.desiredMode !== "live" ||
        sessionId !== this.sessionId ||
        version !== this.audioVersion
      ) {
        live.close();
        return;
      }
      for (const subject of this.speakers) live.speakerStart(subject);
      for (const message of this.recentMessages) this.recordLive(message);
      await this.modes.select(
        createLiveConversationMode({
          isReady: () => Boolean(live.ready),
          sendReply: (reply: any) => {
            if (
              this.closed ||
              version !== this.audioVersion ||
              !this.voice?.context.valid()
            )
              return;
            const results = this.options.currentResults?.() ?? [];
            if (
              reply.targets?.some(
                (target: any) =>
                  target.resultId &&
                  !results.some(
                    (result) =>
                      result.id === target.resultId &&
                      result.runRevision === target.runRevision &&
                      !result.superseded,
                  ),
              )
            )
              return;
            const candidate = this.turns.candidate;
            if (
              !candidate ||
              reply.candidateId !== candidate.id ||
              !this.turns.canStart(candidate)
            )
              return;
            this.candidateId = candidate.id;
            live.resume();
            live.commentary(reply.text);
          },
          onTaskState: () => {},
          stopSpeech: async () => {
            live.silence();
            await this.stopOutput();
          },
        }),
      );
    })()
      .catch(async (error) => {
        if (version !== this.audioVersion) return;
        this.report(error);
        this.live?.close();
        this.live = undefined;
        this.desiredMode = "text-speech";
        await this.modes.select();
      })
      .finally(() => {
        if (this.starting === starting) this.starting = undefined;
      });
    this.starting = starting;
    return starting;
  }
  async handleMedia(event: ConversationInput, context: InputContext) {
    if (!context.valid() || this.closed || !event.capture) return;
    if (this.retiredSessions.has(event.capture.sessionId)) return;
    if (this.sessionId && this.sessionId !== event.capture.sessionId) {
      this.retiredSessions.add(this.sessionId);
      if (this.retiredSessions.size > 200)
        this.retiredSessions.delete(
          this.retiredSessions.values().next().value!,
        );
      this.turns.discard();
      this.quietUntil = 0;
      this.liveSuppressed = false;
      this.utterances.clear();
      this.endedUtterances.clear();
      this.audioVersion++;
      this.sessionId = event.capture.sessionId;
      this.speech.cancel();
      const stopping = this.stopOutput();
      this.live?.close();
      this.live = undefined;
      this.speakers.clear();
      for (const [id, sessionId] of this.pendingTranscriptions)
        if (sessionId !== event.capture.sessionId)
          this.pendingTranscriptions.delete(id);
      this.frameSequences.clear();
      this.switching = stopping.then(() => this.modes.select()).then(() => {});
    }
    this.sessionId = event.capture.sessionId;
    await this.switching;
    if (
      !context.valid() ||
      this.closed ||
      this.sessionId !== event.capture.sessionId
    )
      return;
    if (
      !this.voice ||
      this.voice.event.capture?.sessionId !== this.sessionId ||
      Number(event.replyTo?.speechEpoch ?? 0) >
        Number(this.voice.event.replyTo?.speechEpoch ?? 0) ||
      (Number(event.replyTo?.speechEpoch ?? 0) ===
        Number(this.voice.event.replyTo?.speechEpoch ?? 0) &&
        Number(event.replyTo?.playbackRevision ?? 0) >=
          Number(this.voice.event.replyTo?.playbackRevision ?? 0))
    )
      this.voice = { event, context };
    if (
      Number(event.replyTo?.speechEpoch ?? 0) <
      Number(this.voice?.event.replyTo?.speechEpoch ?? 0)
    )
      return;
    const subject = context.actor.id;
    const utteranceKey = `${subject}:${event.capture.utteranceId}`;
    if (event.activity === "quiet") {
      this.turns.changed();
      this.quietRevision = this.turns.revision;
      this.turns.discard();
      await this.interruptOutput("explicit-stop");
      return;
    }
    if (event.activity === "start") {
      if (
        this.endedUtterances.has(utteranceKey) ||
        this.utterances.get(subject) === event.capture.utteranceId
      )
        return;
      if (!this.turns.candidate) this.liveSuppressed = false;
      this.utterances.set(subject, event.capture.utteranceId);
      this.speakers.add(subject);
      this.turns.changed();
      this.live?.speakerStart(subject);
      return;
    }
    if (event.activity === "interrupt") {
      if (
        this.endedUtterances.has(utteranceKey) ||
        this.utterances.get(subject) !== event.capture.utteranceId
      )
        return;
      await this.turns.interrupt();
      return;
    }
    if (event.activity === "end") {
      if (this.endedUtterances.has(utteranceKey)) return;
      this.endedUtterances.add(utteranceKey);
      if (this.endedUtterances.size > 200)
        this.endedUtterances.delete(
          this.endedUtterances.values().next().value!,
        );
      if (
        this.utterances.has(subject) &&
        this.utterances.get(subject) !== event.capture.utteranceId
      )
        return;
      this.utterances.delete(subject);
      this.speakers.delete(subject);
      this.quietUntil = Math.max(
        this.quietUntil,
        Date.now() + VOICE_TIMING.quietMs - (event.silenceMs ?? 0),
      );
      this.live?.speakerEnd(subject);
      // Segment RPCs and activity RPCs can complete in different orders.
      if (event.capture.segmentIndex > 0) {
        const finalKey = `${context.pluginId}:${event.capture.utteranceId}:segment:${event.capture.segmentIndex - 1}`;
        if (!this.completedTranscriptions.has(finalKey))
          this.pendingTranscriptions.set(finalKey, event.capture.sessionId);
      }
      this.turns.wake();
      return;
    }
    if (!event.audioFrame || this.endedUtterances.has(utteranceKey)) return;
    const key = `${subject}:${event.capture.utteranceId}`;
    if (event.audioFrame.sequence <= (this.frameSequences.get(key) ?? -1))
      return;
    this.frameSequences.set(key, event.audioFrame.sequence);
    if (this.frameSequences.size > 200)
      this.frameSequences.delete(this.frameSequences.keys().next().value!);
    await this.ensureLive();
    if (
      context.valid() &&
      this.sessionId === event.capture.sessionId &&
      this.desiredMode === "live"
    )
      this.live?.input(subject, Buffer.from(event.audioFrame.pcm, "base64"));
  }
  private recordLive(message: AudioMessage) {
    this.live?.recordStatement({
      id: message.id,
      meetingId: message.meetingId,
      sequence: message.sequence,
      userId: message.authorId,
      speakerName: message.authorName ?? message.authorId,
      text: message.text,
      startedAt: message.capture?.startedAt ?? message.at,
    });
  }
  transcription(
    event: ConversationInput,
    context: InputContext,
    active: boolean,
  ) {
    const key = `${context.pluginId}:${event.eventId}`;
    if (active) {
      if (
        !this.closed &&
        context.valid() &&
        !this.completedTranscriptions.has(key)
      ) {
        if (!this.pendingTranscriptions.has(key)) this.turns.changed();
        this.pendingTranscriptions.set(key, event.capture?.sessionId);
      }
    } else {
      this.pendingTranscriptions.delete(key);
      this.completedTranscriptions.add(key);
      if (this.completedTranscriptions.size > 200)
        this.completedTranscriptions.delete(
          this.completedTranscriptions.values().next().value!,
        );
    }
    this.turns.wake();
  }
  observeMessage(message: AudioMessage) {
    this.turns.changed(true);
    const recorded = {
      ...message,
      sequence: message.sequence ?? ++this.messageSequence,
    };
    this.recentMessages.push(recorded);
    this.recentMessages = this.recentMessages.slice(-40);
    this.recordLive(recorded);
  }
  async reply(
    reply: {
      text: string;
      contextRevision?: number;
      replyTo?: ConversationInput["replyTo"];
      sourceIds?: string[];
      reason?: string;
      events?: unknown[];
    },
    _context?: InputContext,
  ) {
    if (
      this.closed ||
      !this.voice?.context.valid() ||
      (_context && !_context.valid())
    )
      return;
    const resultReply = (reply.events ?? []).some(
      (event: any) => event.type === "task_result",
    );
    if (
      reply.contextRevision !== undefined &&
      reply.contextRevision < this.quietRevision
    )
      return;
    if (
      !resultReply &&
      reply.replyTo &&
      ((reply.replyTo.audioSessionId &&
        reply.replyTo.audioSessionId !== this.sessionId) ||
        Number(reply.replyTo.speechEpoch ?? 0) <
          Number(this.voice.event.replyTo?.speechEpoch ?? 0))
    )
      return;
    const stale =
      reply.contextRevision !== undefined &&
      reply.contextRevision !== this.turns.revision;
    if (
      this.turns.blocked ||
      (stale && this.turns.candidate) ||
      (!resultReply && this.turns.handledRevision === this.turns.revision)
    )
      return;
    if (this.desiredMode === "live" && reply.reason === "direct") {
      await this.ensureLive();
      if (this.desiredMode === "live") return;
    }
    this.speech.cancel();
    const previous = this.turns.candidate;
    if (previous) {
      const stopping =
        this.desiredMode === "live"
          ? this.interruptOutput()
          : this.stopOutput();
      const version = this.audioVersion;
      await stopping;
      if (
        this.turns.candidate !== previous ||
        version !== this.audioVersion ||
        this.closed ||
        !this.voice?.context.valid()
      )
        return;
    }
    const candidate = this.turns.offer({
      text: reply.text,
      sourceIds: reply.sourceIds ?? [],
      provider: this.desiredMode,
      targets: [
        ...(reply.sourceIds ?? []).map((text) => ({ text })),
        ...(reply.events ?? []).flatMap((event: any) =>
          event.type === "task_result"
            ? [
                {
                  text: event.id,
                  resultId: event.taskId,
                  runRevision: event.revision,
                },
              ]
            : [],
        ),
      ],
    });
    if (stale) {
      candidate.needsReview = true;
      this.turns.wake();
    }
    return this.launch(candidate);
  }

  async setMode(mode: ConversationModeKind) {
    if (!["live", "text-speech"].includes(mode))
      throw new Error("INVALID_CONVERSATION_MODE");
    if (
      mode === this.desiredMode &&
      (mode === "text-speech" || this.live?.ready)
    )
      return;
    this.turns.discard();
    this.liveSuppressed = false;
    this.audioVersion++;
    this.desiredMode = mode;
    this.speech.cancel();
    await this.stopOutput();
    if (mode === "text-speech") {
      this.live?.close();
      this.live = undefined;
      await this.modes.select();
    } else if (this.voice) await this.ensureLive();
  }
  async close() {
    if (this.closed) return;
    this.turns.close();
    await this.stopOutput();
    this.closed = true;
    this.audioVersion++;
    this.shutdown.abort();
    this.live?.close();
    await this.starting;
    await this.speech.close();
  }
}
