import { randomUUID } from "node:crypto";
import type {
  ConversationInput,
  ConversationModeKind,
  InputContext,
  PluginOutput,
} from "../../../../common/src/contracts/plugins.js";
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
  close(): void;
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
  private revision = 0;
  private messageSequence = 0;
  private speakers = new Set<string>();
  private pendingTranscriptions = new Map<string, string | undefined>();
  private frameSequences = new Map<string, number>();
  private recentMessages: AudioMessage[] = [];
  private live?: LiveSession;
  private starting?: Promise<void>;
  private switching = Promise.resolve();
  private closed = false;
  private audioVersion = 0;
  private candidateId = randomUUID();
  private outputSequence = 0;
  private pendingFrames = 0;
  private shutdown = new AbortController();
  private speech: ReturnType<typeof createSpeechController>;
  private modes: ReturnType<typeof createConversationModeController>;

  constructor(readonly options: ConversationAudioOptions) {
    this.desiredMode = options.mode ?? "text-speech";
    this.speech = createSpeechController({
      getState: () => ({
        meetingId: this.voice?.event.meetingId,
        modeRevision: this.modes?.revision ?? 0,
        enabled: Boolean(this.voice?.context.valid()),
        closed: this.closed,
        paused: false,
        revision: this.revision,
        pendingTranscripts:
          this.speakers.size + this.pendingTranscriptions.size,
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
      onError: (error: unknown) => this.report(error),
    });
    const textSpeech = createTextSpeechConversationMode({
      enqueueSpeech: (reply: any) =>
        this.speech.enqueue({
          ...reply,
          meetingId: this.voice?.event.meetingId,
          modeRevision: this.modes.revision,
        }),
      stopSpeech: async () => {
        this.speech.cancel();
        await this.stopOutput();
        await this.speech.idle();
      },
    });
    this.modes = createConversationModeController({ textSpeech });
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
    if (!playback.canStart() || !this.voice?.context.valid()) return;
    const candidateId = (this.candidateId = randomUUID());
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
    } finally {
      playback.signal?.removeEventListener("abort", cancel);
    }
  }
  private append(pcm: Buffer) {
    if (this.closed || this.pendingFrames >= 32) return;
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
          if (version === this.audioVersion && this.voice?.context.valid())
            return this.options.recordAssistant({
              ...event,
              meetingId: this.voice?.event.meetingId,
            });
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
    if (this.sessionId && this.sessionId !== event.capture.sessionId) {
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
      Number(event.replyTo?.speechEpoch ?? 0) >=
        Number(this.voice.event.replyTo?.speechEpoch ?? 0)
    )
      this.voice = { event, context };
    const subject = context.actor.id;
    if (event.activity === "quiet") {
      this.speech.cancel();
      this.live?.silence();
      await this.stopOutput();
      return;
    }
    if (event.activity === "start") {
      this.speakers.add(subject);
      this.live?.speakerStart(subject);
      return;
    }
    if (event.activity === "end") {
      this.speakers.delete(subject);
      this.live?.speakerEnd(subject);
      return;
    }
    if (!event.audioFrame) return;
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
      if (!this.closed && context.valid())
        this.pendingTranscriptions.set(key, event.capture?.sessionId);
    } else this.pendingTranscriptions.delete(key);
  }
  observeMessage(message: AudioMessage) {
    this.revision++;
    this.speech.cancel();
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
      sourceIds?: string[];
      reason?: string;
      events?: unknown[];
    },
    _context?: InputContext,
  ) {
    if (this.closed || !this.voice?.context.valid()) return;
    const version = this.audioVersion;
    if (this.desiredMode === "live") {
      await this.ensureLive();
      if (this.desiredMode === "live" && reply.reason === "direct") return;
    }
    if (version !== this.audioVersion) return;
    return this.modes.routeReply(
      {
        text: reply.text,
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
      },
      { modeRevision: this.modes.revision },
    );
  }
  async setMode(mode: ConversationModeKind) {
    if (!["live", "text-speech"].includes(mode))
      throw new Error("INVALID_CONVERSATION_MODE");
    if (
      mode === this.desiredMode &&
      (mode === "text-speech" || this.live?.ready)
    )
      return;
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
    await this.stopOutput();
    this.closed = true;
    this.audioVersion++;
    this.shutdown.abort();
    this.live?.close();
    await this.starting;
    await this.speech.close();
  }
}
