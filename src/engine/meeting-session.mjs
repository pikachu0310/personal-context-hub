import { invocationAcknowledgement } from "./observation/invocation.mjs";
import { createSpeechTicket } from "./reply/speech-ticket.mjs";
import { createTelemetry } from "./telemetry.mjs";
import { MeetingMemory } from "./observation/memory.mjs";
import { deliverSpeech } from "./output/speech.mjs";
import { randomUUID } from "node:crypto";
import {
  mayReplyImmediately,
  hasTaskCommitment,
  normalizeTaskTopic,
  shouldDeliverObservationReply,
} from "./observation/participation.mjs";
import { VoiceServiceError, voiceErrorCode } from "./errors.mjs";
import {
  boundText,
  boundRecentText,
  speechExcerpt,
  withTimeout,
  DEFAULT_STAGE_TIMEOUTS,
  MAX_TRANSCRIPT_CHARACTERS,
} from "./shared.mjs";
const MAX_MEETING_TRANSCRIPT_CHARACTERS = 16_000;
import { plainPresentation } from "./output/presentation.mjs";
function controlReceiptText(control, result) {
  if (!result)
    return "操作対象が見つかりません。タスクIDと作業一覧を確認して再度依頼してください。";
  if (result.type === "superseded")
    return `タスク ${control.taskId} は後から停止されたため、停止前の追加指示は実行していません。`;
  if (result.type === "full")
    return "追加指示の枠が満杯のため、今回の指示は受け付けていません。空きができたら再度依頼してください。";
  return control.type === "stop"
    ? `タスク ${control.taskId} を停止しました。`
    : `タスク ${control.taskId} への追加指示を保存しました。`;
}
import { SpeechTurnAssembler } from "./input/utterances.mjs";
import {
  parseImmediateTaskStop,
  parseImmediateTaskInstruction,
  isImmediateTaskStatus,
  isImmediateSpeechStop,
} from "./observation/intents.mjs";
import {
  speakerLabel,
  formatMeetingObservationTranscript,
  parseMeetingObservation,
  authorizeMeetingTasks,
  authorizeMeetingTaskControls,
} from "./observation/observation.mjs";
export class MeetingSession {
  constructor({
    telemetry = createTelemetry(),
    presentation = plainPresentation,
    speechEnabled = true,
    transcribe,
    observe,
    quickReply,
    classifyVoiceNeed,
    revalidateReply,
    investigateQuestion,
    getRuntimeContext = () => ({}),
    upsertLiveTranscript,
    upsertMinutes,
    archiveTranscript = async () => undefined,
    closeTranscriptArchive = async () => undefined,
    postText,
    synthesize,
    playAudio,
    speak,
    isLive = () => false,
    stopSpeech = () => {},
    onStatement = () => {},
    enqueueTask = () => false,
    controlTask = () => false,
    getTaskReceipt = () => undefined,
    getTaskResult = () => undefined,
    ownerUserId,
    tasksEnabled = false,
    operatorUserIds = [],
    allParticipantsOperate = false,
    autonomousTasks = false,
    answerUnaddressedQuestions = false,
    requireWakeWord = false,
    initialState = {},
    checkpoint = async () => undefined,
    getTasks = () => [],
    logger = console,
    observationIntervalMs = 60_000,
    immediateReactions = false,
    transcriptionConcurrency = 4,
    maximumPendingTranscriptions = 60,
    stageTimeouts = {},
    scheduleInterval = setInterval,
    cancelInterval = clearInterval,
  }) {
    this.telemetry = telemetry;
    this.presentation = presentation;
    this.speechEnabled = speechEnabled;
    this.dependencies = {
      transcribe,
      observe,
      quickReply,
      classifyVoiceNeed,
      revalidateReply,
      investigateQuestion,
      getRuntimeContext,
      upsertLiveTranscript,
      upsertMinutes,
      archiveTranscript,
      closeTranscriptArchive,
      postText,
      synthesize,
      playAudio,
      speak,
      isLive,
      stopSpeech,
      onStatement,
      enqueueTask,
      controlTask,
      getTaskReceipt,
      getTaskResult,
    };
    this.logger = logger;
    this.ownerUserId = ownerUserId;
    this.operatorUserIds = operatorUserIds;
    this.allParticipantsOperate = allParticipantsOperate;
    this.autonomousTasks = autonomousTasks;
    this.answerUnaddressedQuestions = answerUnaddressedQuestions;
    this.requireWakeWord = requireWakeWord;
    this.checkpoint = checkpoint;
    this.getTasks = getTasks;
    this.tasksEnabled = tasksEnabled;
    this.stageTimeouts = { ...DEFAULT_STAGE_TIMEOUTS, ...stageTimeouts };
    this.transcriptionConcurrency = transcriptionConcurrency;
    this.maximumPendingTranscriptions = maximumPendingTranscriptions;
    this.immediateReactions = immediateReactions;
    this.cancelInterval = cancelInterval;
    this.audioQueue = [];
    this.activeTranscriptions = 0;
    this.replyContextRevision = 0;
    this.speechCandidates = new Map();
    this.latestSpeechOrders = new Map();
    this.announcedResults = new Set();
    this.activeTranscriptionJobs = new Set();
    this.activeOperations = new Set();
    this.archiveOperations = new WeakMap();
    this.meetingId = initialState.meetingId ?? randomUUID();
    this.statements = initialState.statements ?? [];
    this.recentConversation =
      initialState.recentConversation ??
      this.statements.slice(-20).map((statement) => ({
        role: "user",
        sequence: statement.sequence,
        speakerName: statement.speakerName,
        text: boundText(statement.text, 1200),
      }));
    this.sequence = initialState.sequence ?? 0;
    this.minutes = initialState.minutes ?? "";
    this.memory = new MeetingMemory(initialState.memory);
    this.results = initialState.results ?? [];
    this.pendingTasks = structuredClone(initialState.pendingTasks ?? []).map(
      (task) => ({
        ...task,
        id:
          getTaskReceipt(task.requestKey)?.id ??
          task.id ??
          randomUUID().slice(0, 8),
      }),
    );
    this.pendingControls = initialState.pendingControls ?? [];
    this.controlsAttempted = new WeakSet();
    this.speechTurns = new SpeechTurnAssembler(initialState.speechTurns ?? []);
    this.speechTurns.interrupt();
    this.statements.push(...this.speechTurns.drain());
    this.revision = initialState.revision ?? 0;
    this.resetting = false;
    this.meetingBoundary = Promise.resolve();
    this.activeTextInputs = 0;
    this.observing = false;
    this.processingConversation = false;
    this.observationRetryPending = false;
    this.observationFailureMessage = "";
    this.immediateObservationRequested = false;
    this.immediateObservationScheduled = false;
    this.closed = false;
    this.droppedAudio = 0;
    this.failedTranscriptions = 0;
    this.archiveFailures = 0;
    this.shutdownController = new AbortController();
    this.liveUpdate = Promise.resolve();
    this.speechQueue = Promise.resolve();
    this.pendingSpeechCount = 0;
    this.activeQuickReplies = 0;
    this.activeInvestigations = 0;
    this.voicePaused = false;
    this.speechController = new AbortController();
    this.silencedThroughSequence = initialState.silencedThroughSequence ?? null;
    this.speechStopSavePending = false;
    this.interval = scheduleInterval(
      () => void this.observeNow(),
      observationIntervalMs,
    );
    this.interval?.unref?.();
    this.#queueLiveUpdate();
  }

  enqueue(wav, metadata = {}) {
    if (!Buffer.isBuffer(wav)) throw new TypeError("wav must be a Buffer");
    if (this.closed) return false;
    const turn = metadata.utteranceId
      ? this.speechTurns.register(metadata.utteranceId, metadata.segmentIndex, {
          meetingId: this.meetingId,
          sequence:
            this.speechTurns.turns.get(metadata.utteranceId)?.sequence ??
            (this.resetting ? undefined : ++this.sequence),
          taskEligible: metadata.taskEligible !== false,
          requestReply: metadata.requestReply === true,
          inputId: metadata.inputId,
          taskId: metadata.taskId,
          requestKey: metadata.requestKey,
          userId: metadata.userId,
          speakerName: metadata.speakerName,
          startedAt: metadata.startedAt ?? Date.now(),
        })
      : undefined;
    const pending = this.audioQueue.length + this.activeTranscriptions;
    if (pending >= this.maximumPendingTranscriptions) {
      if (turn)
        this.speechTurns.settle(turn.id, metadata.segmentIndex, undefined);
      this.droppedAudio += 1;
      this.#log("meeting_audio_dropped", { pending });
      this.#queueLiveUpdate();
      return true;
    }
    this.audioQueue.push({
      id: metadata.inputId ?? randomUUID(),
      sequence:
        turn?.sequence ?? (this.resetting ? undefined : (this.sequence += 1)),
      wav,
      metadata,
      queuedAt: Date.now(),
    });
    this.#recordQueuedAudio(this.audioQueue.at(-1));
    this.#drainTranscriptions();
    return true;
  }

  #recordQueuedAudio(queued) {
    if (queued.sequence === undefined || queued.hudRecorded) return;
    queued.hudRecorded = true;
    const inputIds = [`${this.meetingId}:I-${queued.sequence}`];
    this.telemetry.emit({
      stage: "AUDIO",
      spanId: `audio-${queued.id}-${queued.metadata.segmentIndex ?? 0}`,
      status: "completed",
      at: queued.queuedAt,
      inputIds,
    });
    this.telemetry.emit({
      stage: "STT",
      spanId: `stt-wait-${queued.id}-${queued.metadata.segmentIndex ?? 0}`,
      status: "waiting",
      reason: "transcription_capacity",
      inputIds,
    });
    this.telemetry.emit({
      stage: "ASSEMBLE",
      spanId: `input-${this.meetingId}-${queued.sequence}`,
      status: "waiting",
      reason: "transcript_segments",
      inputIds,
    });
  }

  async persist() {
    const silencedThroughSequence = this.silencedThroughSequence;
    await this.checkpoint({
      meetingId: this.meetingId,
      revision: this.revision,
      sequence: this.sequence,
      minutes: this.minutes,
      memory: this.memory.snapshot(),
      statements: this.statements,
      recentConversation: this.recentConversation,
      results: this.results,
      pendingTasks: structuredClone(this.pendingTasks),
      pendingControls: structuredClone(this.pendingControls),
      speechTurns: this.speechTurns.snapshot(),
      silencedThroughSequence,
    });
    if (this.silencedThroughSequence === silencedThroughSequence)
      this.speechStopSavePending = false;
  }

  addText(text, metadata = {}) {
    if (this.closed) return Promise.resolve(false);
    return this.#trackOperation(this.#addText(text, metadata));
  }

  getActiveTasks() {
    const tasks = new Map(this.getTasks().map((task) => [task.id, task]));
    for (const task of this.pendingTasks) {
      if (!tasks.has(task.id) || tasks.get(task.id).state === "failed")
        tasks.set(task.id, {
          id: task.id,
          title: task.title,
          state: task.cancelled
            ? "cancelled"
            : task.rejectionReason
              ? "rejected"
              : "awaiting_receipt",
        });
    }
    return [...tasks.values()];
  }

  getObservationTaskContext(statements) {
    const all = this.getActiveTasks();
    const active = all.filter((task) =>
      ["queued", "running", "awaiting_receipt"].includes(task.state),
    );
    const text = statements
      .map((statement) => statement.text)
      .join("\n")
      .toLowerCase();
    const mentioned = all.filter(
      (task) => task.id && text.includes(String(task.id).toLowerCase()),
    );
    const recent = [...all]
      .reverse()
      .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      .slice(0, 10);
    const selected = [
      ...new Map(
        [...mentioned, ...active, ...recent].map((task) => [task.id, task]),
      ).values(),
    ].slice(0, 80);
    return {
      activeTasks: selected.map((task) => ({
        ...task,
        title: boundText(task.title, 160),
      })),
      taskListSummary: {
        total: all.length,
        active: active.length,
        omitted: all.length - selected.length,
      },
    };
  }

  getObservationResults(statements) {
    const text = statements
      .map((statement) => statement.text)
      .join("\n")
      .toLowerCase();
    const tasks = this.getActiveTasks();
    const saved = tasks
      .map((task) => this.dependencies.getTaskResult(task.id))
      .filter(
        (result) => result?.result && result.meetingId === this.meetingId,
      );
    const recent = [
      ...new Map(
        [
          ...this.results.slice(-5).map((result) => ({
            ...result,
            ...this.dependencies.getTaskResult(result.id),
          })),
          ...saved,
        ].map((result) => [result.id, result]),
      ).values(),
    ]
      .sort((a, b) => (a.completedAt ?? 0) - (b.completedAt ?? 0))
      .slice(-5);
    const named = tasks
      .filter((task) => task.id && text.includes(String(task.id).toLowerCase()))
      .slice(0, 3)
      .map((task) => this.dependencies.getTaskResult(task.id))
      .filter(Boolean);
    const results = [
      ...new Map(
        [...recent, ...named].map((result) => [result.id, result]),
      ).values(),
    ];
    return results.map((result) => ({
      id: result.id,
      title: boundText(result.title, 160),
      state: result.state,
      currentState: result.currentState,
      runRevision: result.runRevision,
      currentRunRevision: result.currentRunRevision,
      resultDeliveryPending: result.resultDeliveryPending,
      result: boundText(result.result, 4000),
      verification: result.verification,
      threadId: result.threadId,
      meetingId: result.meetingId,
      resultWasTruncated:
        result.resultWasTruncated === true ||
        String(result.result ?? "").length > 4000,
    }));
  }

  cancelPendingTask(taskId) {
    if (!taskId) return Promise.resolve(false);
    const task = this.pendingTasks.find(
      (entry) =>
        entry.id === taskId ||
        this.dependencies.getTaskReceipt(entry.requestKey)?.id === taskId,
    );
    if (!task) return Promise.resolve(false);
    task.cancelled = true;
    return this.#trackOperation(this.#savePendingCancellation(task));
  }

  async #savePendingCancellation(task) {
    const receipt = this.dependencies.getTaskReceipt(task.requestKey);
    try {
      const stopped = this.dependencies.controlTask({
        type: "stop",
        taskId: receipt?.id ?? task.id,
        requestKey: `${task.requestKey}:cancel-pending`,
      });
      const [, result] = await Promise.all([this.persist(), stopped]);
      return {
        type: "cancelled",
        ...(result?.persisted === false ? { persisted: false } : {}),
      };
    } catch {
      return { type: "cancelled", persisted: false };
    }
  }

  finishUtterance(id, count, { incomplete = false } = {}) {
    if (this.closed) return Promise.resolve(false);
    this.speechTurns.finish(id, count, incomplete);
    return this.#trackOperation(this.#flushSpeechTurns());
  }

  beginUtterance(id, metadata = {}) {
    if (this.closed) return false;
    this.speechTurns.register(id, 0, {
      meetingId: this.meetingId,
      sequence: this.resetting ? undefined : ++this.sequence,
      taskEligible: metadata.taskEligible !== false,
      requestReply: metadata.requestReply === true,
      inputId: metadata.inputId,
      taskId: metadata.taskId,
      requestKey: metadata.requestKey,
      userId: metadata.userId,
      speakerName: metadata.speakerName,
      startedAt: metadata.startedAt ?? Date.now(),
    });
    return true;
  }

  async #flushSpeechTurns() {
    const completed = this.speechTurns.drain();
    this.statements.push(...completed);
    for (const statement of completed) {
      await this.#tryImmediateTaskAction(statement);
      await this.#archiveStatement(statement);
    }
    await this.persist();
    this.#queueLiveUpdate();
    if (
      completed.some(
        (statement) =>
          !statement.handledAction &&
          mayReplyImmediately(statement, this.immediateReactions),
      )
    ) {
      this.immediateObservationRequested = true;
      this.#scheduleImmediateObservation();
    }
  }

  async #addText(text, metadata = {}) {
    const receivedAt = metadata.startedAt ?? Date.now();
    while (this.resetting) await this.meetingBoundary;
    if (this.closed || !String(text).trim()) return false;
    this.activeTextInputs++;
    try {
      const statement = {
        id: metadata.inputId ?? randomUUID(),
        inputId: metadata.inputId,
        taskId: metadata.taskId,
        requestKey: metadata.requestKey,
        meetingId: this.meetingId,
        sequence: ++this.sequence,
        userId: metadata.userId,
        speakerName: metadata.speakerName,
        taskEligible: metadata.taskEligible !== false,
        requestReply: metadata.requestReply === true,
        startedAt: receivedAt,
        text: boundText(text, MAX_TRANSCRIPT_CHARACTERS),
        observed: false,
        archived: false,
      };
      this.statements.push(statement);
      await this.#tryImmediateTaskAction(statement);
      await this.#archiveStatement(statement);
      await this.persist();
      this.#queueLiveUpdate();
      if (
        !statement.handledAction &&
        mayReplyImmediately(statement, this.immediateReactions)
      ) {
        this.immediateObservationRequested = true;
        this.#scheduleImmediateObservation();
      }
      return true;
    } finally {
      this.activeTextInputs--;
    }
  }

  #tryImmediateTaskAction(statement) {
    return this.telemetry.scope(
      { inputIds: [`${this.meetingId}:I-${statement.sequence}`] },
      () => this.#tryImmediateTaskActionObserved(statement),
    );
  }

  async #tryImmediateTaskActionObserved(statement) {
    this.telemetry.emit({
      stage: "ASSEMBLE",
      spanId: `input-${this.meetingId}-${statement.sequence}`,
      status: "completed",
      text: statement.text,
      speaker: statement.speakerName,
    });
    this.#replyDiagnostic(
      statement,
      mayReplyImmediately(statement, this.immediateReactions)
        ? "呼びかけを検出"
        : "呼びかけなし・通常の会話",
    );
    this.replyContextRevision++;
    this.memory.remember(statement);
    this.dependencies.onStatement(statement);
    if (
      !this.recentConversation.some(
        (item) => item.role === "user" && item.sequence === statement.sequence,
      )
    ) {
      this.recentConversation.push({
        role: "user",
        sequence: statement.sequence,
        speakerName: statement.speakerName,
        text: boundText(statement.text, 1200),
      });
      this.recentConversation = this.recentConversation.slice(-24);
    }
    if (isImmediateSpeechStop(statement.text))
      return this.#tryImmediateSpeechStop(statement);
    if (!mayReplyImmediately(statement)) return false;
    if (await this.#tryImmediateInstruction(statement)) return true;
    const handled = await (isImmediateTaskStatus(statement.text, {
      explicitlyAsked: statement.requestReply === true,
    })
      ? this.#tryImmediateStatus(statement)
      : this.#tryImmediateStop(statement));
    if (!handled) this.#startQuickReply(statement);
    return handled;
  }

  getReplyContext(statement) {
    return {
      memory: this.memory.context(statement.text, 4),
      minutes: boundText(this.minutes, 5000),
      conversation: this.recentConversation.slice(-20),
      tasks: this.getObservationTaskContext([statement])
        .activeTasks.slice(0, 20)
        .map((task) => ({
          id: task.id,
          title: task.title,
          state: task.state,
          threadId: task.threadId,
          resultDeliveryPending: task.resultDeliveryPending,
        })),
      results: this.getObservationResults([statement]).map((result) => ({
        ...result,
        result: boundText(result.result, 2000),
      })),
      runtime: this.dependencies.getRuntimeContext(),
    };
  }

  async #tryImmediateInstruction(statement) {
    if (
      !this.tasksEnabled ||
      !this.ownerUserId ||
      statement.taskEligible === false ||
      statement.handledAction ||
      !(
        (this.allParticipantsOperate && statement.userId) ||
        statement.userId === this.ownerUserId ||
        this.operatorUserIds.includes(statement.userId)
      )
    )
      return false;
    const parsed = parseImmediateTaskInstruction(statement.text, {
      requireWakeWord: this.requireWakeWord,
    });
    if (!parsed) return false;
    const all = this.getActiveTasks();
    const candidates = all.filter(
      (task) =>
        ["running", "queued"].includes(task.state) ||
        (task.state === "completed" && task.preview?.state === "available"),
    );
    const target = parsed.taskId
      ? all.find(
          (task) => task.id.toLowerCase() === parsed.taskId.toLowerCase(),
        )
      : candidates.length === 1
        ? candidates[0]
        : undefined;
    if (!target) return false; // The observer resolves ambiguous references without racing a guessed target.
    const control = {
      type: "instruction",
      taskId: target.id,
      instruction: statement.text,
      sourceSequences: [statement.sequence],
      expectedControlVersion: target.controlVersion ?? 0,
      requestKey: `${this.meetingId}:control:instruction:${statement.sequence}`,
      spokenNotification: "",
    };
    statement.handledAction = { type: "instruction", taskId: target.id };
    statement.taskEligible = false;
    this.pendingControls.push(control);
    const startedAt = Date.now();
    try {
      const result = await this.#applyMeetingControl(control);
      control.notification = controlReceiptText(control, result);
      this.#log("immediate_instruction_received", {
        taskId: target.id,
        sequence: statement.sequence,
        receiptMs: Date.now() - startedAt,
      });
      await this.persist();
      await this.#dispatchPendingControls();
    } catch {
      this.#log("immediate_instruction_receipt_pending", {
        taskId: target.id,
        sequence: statement.sequence,
      });
    }
    return true;
  }

  #replyDiagnostic(statement, decision) {
    if (statement.meetingId !== this.meetingId) return;
    if (this.lastReplyDecision?.sequence > statement.sequence) return;
    this.lastReplyDecision = { sequence: statement.sequence, decision };
    this.#log("meeting_invocation_decision", this.lastReplyDecision);
    this.#queueLiveUpdate();
  }

  #startQuickReply(statement) {
    if (
      this.dependencies.isLive() ||
      !this.dependencies.quickReply ||
      statement.handledAction ||
      !mayReplyImmediately(statement, this.immediateReactions) ||
      (!statement.requestReply &&
        /(?:実装|修正|作成|調査|検索|ベンチマーク|テスト)(?:して|をお願い)|作って|直して|調べて/u.test(
          statement.text,
        ))
    )
      return;
    if (this.activeQuickReplies >= 3) {
      this.#replyDiagnostic(statement, "返信処理が混雑・会話確認へ");
      return;
    }
    this.#replyDiagnostic(statement, "回答を確認中");
    this.activeQuickReplies++;
    statement.handledAction = { type: "quick_reply", pending: true };
    const startedAt = Date.now();
    const context = this.getReplyContext(statement);
    const explicitlyAsked = true;
    this.#trackOperation(
      (async () => {
        let reply;
        let investigated = false;
        try {
          if (
            this.dependencies.classifyVoiceNeed &&
            !invocationAcknowledgement(statement.text)
          ) {
            const need = await withTimeout(
              (signal) =>
                this.dependencies.classifyVoiceNeed(
                  { text: statement.text, context },
                  { signal },
                ),
              15_000,
              "classifying voice need",
              this.shutdownController.signal,
            );
            this.#log("meeting_voice_need", {
              sequence: statement.sequence,
              decision: need.decision,
            });
            if (need.decision !== "reply") {
              this.#replyDiagnostic(statement, "音声回答は不要と判定");
              statement.handledAction = { type: "quick_reply", ignored: true };
              await this.persist();
              return;
            }
          }
          const rawDecision = await withTimeout(
            (signal) =>
              this.dependencies.quickReply(
                { text: statement.text, context, explicitlyAsked },
                { signal },
              ),
            15_000,
            "answering voice question",
            this.shutdownController.signal,
          );
          const decision =
            typeof rawDecision === "string"
              ? { action: "reply", reply: rawDecision }
              : rawDecision;
          if (decision?.action === "ignore") {
            this.#replyDiagnostic(statement, "回答を見送り");
            statement.handledAction = { type: "quick_reply", ignored: true };
            await this.persist();
            this.#log("meeting_quick_reply_ignored", {
              sequence: statement.sequence,
            });
            return;
          }
          if (decision?.action === "investigate") {
            this.#replyDiagnostic(statement, "資料・ログを確認中");
            if (!this.dependencies.investigateQuestion)
              throw new Error("Question investigation unavailable");
            investigated = true;
            statement.taskEligible = false;
            statement.handledAction = {
              type: "investigated_reply",
              pending: true,
            };
            this.activeInvestigations++;
            this.#queueLiveUpdate();
            try {
              reply = await withTimeout(
                (signal) =>
                  this.dependencies.investigateQuestion(
                    {
                      text: statement.text,
                      context: this.getReplyContext(statement),
                    },
                    { signal },
                  ),
                this.stageTimeouts.observing ??
                  Math.min(this.stageTimeouts.running_codex, 120_000),
                "checking question evidence",
                this.shutdownController.signal,
              );
            } finally {
              this.activeInvestigations--;
              this.#queueLiveUpdate();
            }
          } else if (decision?.action === "reply") reply = decision.reply;
          else throw new Error("Invalid reply decision");
          reply = boundText(reply, investigated ? 5000 : 1200);
          if (!reply) throw new Error("Empty reply");
          if (this.closed) return;
          this.#replyDiagnostic(statement, "回答を作成・送信待ち");
          this.#log("meeting_quick_reply_completed", {
            sequence: statement.sequence,
            elapsedMs: Date.now() - startedAt,
            investigated,
          });
        } catch (error) {
          if (this.closed) return;
          this.#replyDiagnostic(statement, "回答処理に失敗");
          this.#log("meeting_quick_reply_failed", {
            errorCode: voiceErrorCode(error),
          });
          if (investigated || explicitlyAsked) {
            await this.#saveImmediateReply(
              statement,
              {
                type: "reply",
                meetingId: statement.meetingId,
                sourceSequences: [statement.sequence],
                requestKey: `${statement.meetingId}:question-failed:${statement.sequence}`,
                notification:
                  "質問の確認処理に失敗しました。ソースやログの確認結果はまだ得られていません。",
                spokenNotification: "",
              },
              { type: "investigated_reply", failed: true },
            );
          } else {
            statement.handledAction = { type: "quick_reply", ignored: true };
            await this.persist();
          }
          return;
        }
        this.replyContextRevision++;
        this.recentConversation.push({
          role: "assistant",
          sequence: statement.sequence,
          speakerName: "井戸Bot",
          text: boundText(reply, 1600),
        });
        this.recentConversation = this.recentConversation.slice(-24);
        await this.#saveImmediateReply(
          statement,
          {
            type: "reply",
            meetingId: statement.meetingId,
            sourceSequences: [statement.sequence],
            requestKey: `${statement.meetingId}:quick:${statement.sequence}`,
            notification: reply,
            spokenNotification: this.#canSpeakFor([statement.sequence])
              ? speechExcerpt(investigated ? boundText(reply, 450) : reply)
              : "",
          },
          { type: investigated ? "investigated_reply" : "quick_reply" },
        );
      })().finally(() => {
        this.activeQuickReplies--;
      }),
    );
  }

  async #tryImmediateStatus(statement) {
    if (
      !statement.userId ||
      statement.handledAction ||
      (statement.taskEligible === false && !statement.requestReply)
    )
      return false;
    const tasks = this.getActiveTasks();
    const count = (state) =>
      tasks.filter((task) => task.state === state).length;
    const summary = `実行中${count("running")}件、待機${count("queued")}件、受付中${count("awaiting_receipt")}件です。`;
    const deliveries = tasks.filter(
      (task) => task.resultDeliveryPending,
    ).length;
    const attention = `失敗${count("failed")}件、中断・再開待ち${count("interrupted")}件です。${deliveries ? `結果送信待ちが${deliveries}件あります。` : ""}`;
    const active = tasks.filter((task) =>
      ["running", "queued", "awaiting_receipt"].includes(task.state),
    );
    const at = new Date().toLocaleString("ja-JP", {
      timeZone: "Asia/Tokyo",
      hour12: false,
    });
    const control = {
      type: "status",
      sourceSequences: [statement.sequence],
      requestKey: `${this.meetingId}:status:${statement.sequence}`,
      notification: [
        `作業状況（${at} JST 確認時点）`,
        summary,
        attention,
        ...active
          .slice(0, 3)
          .map((task) =>
            this.presentation.taskLabel(task.id, boundText(task.title, 80)),
          ),
        this.presentation.historyHelp(tasks.length),
      ].join("\n"),
      spokenNotification: `確認した時点では、${summary}${attention}`,
    };
    return this.#saveImmediateReply(statement, control, { type: "status" });
  }

  silenceSpeech() {
    if (this.closed) return Promise.resolve(undefined);
    this.dependencies.stopSpeech();
    const count = this.pendingSpeechCount;
    this.silencedThroughSequence = this.sequence;
    this.speechStopSavePending = true;
    for (const control of this.pendingControls) control.spokenNotification = "";
    this.speechController.abort(
      new VoiceServiceError(
        "SPEECH_STOPPED",
        "Speech stopped by an operator",
        "読み上げを停止しました。",
      ),
    );
    this.speechController = new AbortController();
    return this.#trackOperation(
      this.persist()
        .then(() => ({ count, persisted: true }))
        .catch(() => {
          this.speechStopSavePending = true;
          return { count, persisted: false };
        }),
    );
  }

  async #tryImmediateSpeechStop(statement) {
    if (
      statement.taskEligible === false ||
      !this.ownerUserId ||
      !(
        (this.allParticipantsOperate && Boolean(statement.userId)) ||
        statement.userId === this.ownerUserId ||
        this.operatorUserIds.includes(statement.userId)
      )
    )
      return false;
    statement.taskEligible = false;
    statement.handledAction = { type: "speech_stop" };
    const result = await this.silenceSpeech();
    return this.#saveImmediateReply(
      statement,
      {
        type: "reply",
        meetingId: this.meetingId,
        requestKey: `${this.meetingId}:speech-stop:${statement.sequence}`,
        sourceSequences: [statement.sequence],
        spokenNotification: "",
        notification:
          result?.persisted === false
            ? "読み上げを停止しました。停止の記録は保存を再試行しています。"
            : "読み上げを停止しました。次の質問には通常どおり応答します。",
      },
      { type: "speech_stop" },
    );
  }

  async #saveImmediateReply(statement, control, handledAction) {
    control.participantUserIds = statement.userId ? [statement.userId] : [];
    control.taskId ??= statement.taskId;
    if (!(this.autonomousTasks && handledAction.type === "quick_reply"))
      statement.taskEligible = false;
    statement.handledAction = handledAction;
    control.speechTargets ??= [
      { sequence: statement.sequence, text: statement.text },
    ];
    // This is a notification-only receipt. Replaying it never invokes a worker or control.
    this.pendingControls.push(control);
    try {
      await this.persist();
      await this.#dispatchPendingControls();
      if (
        this.pendingControls.includes(control) &&
        !this.controlsAttempted.has(control)
      )
        await this.#dispatchPendingControls();
    } catch (error) {
      this.#log("immediate_reply_pending", {
        errorCode: voiceErrorCode(error),
      });
    }
    return true;
  }

  async #tryImmediateStop(statement) {
    if (
      !this.tasksEnabled ||
      statement.taskEligible === false ||
      !this.ownerUserId ||
      !(
        (this.allParticipantsOperate && Boolean(statement.userId)) ||
        statement.userId === this.ownerUserId ||
        this.operatorUserIds.includes(statement.userId)
      )
    )
      return false;
    const parsed = parseImmediateTaskStop(statement.text);
    if (!parsed) return false;
    const all = this.getActiveTasks();
    const active = all.filter((task) =>
      ["queued", "running", "awaiting_receipt"].includes(task.state),
    );
    const taskId = parsed.taskId
      ? all.find(
          (task) =>
            String(task.id).toLowerCase() === parsed.taskId.toLowerCase(),
        )?.id
      : active.length === 1
        ? active[0].id
        : undefined;
    if (!taskId) {
      const reason = parsed.taskId
        ? "not_found"
        : active.length
          ? "ambiguous"
          : "none_active";
      const explanation = parsed.taskId
        ? `受付時点の履歴にタスク ${parsed.taskId} が見つからなかったため、停止操作はしていません。`
        : active.length
          ? `受付時点で作業が${active.length}件あり、対象を一つに特定できなかったため、停止操作はしていません。`
          : "受付時点で実行中・待機中の作業はありませんでした。停止操作はしていません。";
      return this.#saveImmediateReply(
        statement,
        {
          type: "reply",
          meetingId: this.meetingId,
          sourceSequences: [statement.sequence],
          requestKey: `${this.meetingId}:stop-target:${statement.sequence}`,
          notification: [
            explanation,
            ...active
              .slice(0, 3)
              .map((task) =>
                this.presentation.taskLabel(
                  task.id,
                  boundText(String(task.title ?? "").replace(/\s+/g, " "), 80),
                ),
              ),
            this.presentation.stopHelp(),
          ].join("\n"),
          spokenNotification:
            reason === "ambiguous"
              ? "作業が複数あるため、停止していません。止めるタスクのIDを指定してください。"
              : `${explanation}必要ならテキストの作業一覧を確認してください。`,
        },
        { type: "stop", applied: false, reason },
      );
    }
    const control = {
      type: "stop",
      taskId,
      sourceSequences: [statement.sequence],
      requestKey: `${this.meetingId}:control:stop:${statement.sequence}`,
    };
    statement.taskEligible = false;
    statement.handledAction = { type: "stop", taskId };
    this.pendingControls.push(control);
    try {
      const result = await withTimeout(
        () => this.#applyMeetingControl(control),
        this.stageTimeouts.posting,
        "saving immediate stop",
        this.shutdownController.signal,
      );
      if (result?.persisted !== false)
        control.notification = controlReceiptText(control, result);
      else
        await withTimeout(
          (signal) =>
            this.dependencies.postText(
              `タスク ${taskId} は停止しましたが、停止状態の保存を再試行しています。`,
              { signal },
            ),
          this.stageTimeouts.posting,
          "posting pending stop status",
          this.shutdownController.signal,
        );
      await this.persist();
      await this.#dispatchPendingControls();
      // A dispatcher already posting another receipt may have taken its snapshot before this stop.
      if (
        this.pendingControls.includes(control) &&
        control.notification &&
        !this.controlsAttempted.has(control)
      )
        await this.#dispatchPendingControls();
    } catch (error) {
      this.#log("immediate_stop_receipt_pending", {
        taskId,
        errorCode: voiceErrorCode(error),
      });
    }
    return true;
  }

  getContextSnapshot() {
    const pending = this.statements
      .filter((statement) => !statement.observed)
      .sort((a, b) => a.sequence - b.sequence);
    const recent = [];
    let used = 0;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const statement = pending[index];
      const size = statement.text.length + speakerLabel(statement).length + 4;
      if (used + size > MAX_MEETING_TRANSCRIPT_CHARACTERS) {
        if (!recent.length)
          recent.unshift({
            ...statement,
            text: boundRecentText(
              statement.text,
              MAX_MEETING_TRANSCRIPT_CHARACTERS -
                speakerLabel(statement).length -
                4,
            ),
          });
        break;
      }
      recent.unshift(statement);
      used += size;
    }
    return [
      `会議 ${this.meetingId} · 議事録 rev ${this.revision}`,
      this.minutes,
      "根拠付きの前提・決定・未決定（会話の解釈）:",
      JSON.stringify(
        this.memory.context(
          pending.map((statement) => statement.text).join("\n"),
          6,
        ),
      ),
      "議事録へ未反映の発言（訂正を含む）:",
      pending.length > recent.length
        ? `古い未反映発言 ${pending.length - recent.length} 件を省略。以下の最新発言を優先。`
        : "",
      formatMeetingObservationTranscript(recent),
      "直近の作業結果（詳細は各タスク）:",
      JSON.stringify(
        this.getObservationResults([]).map((result) => ({
          ...result,
          result: boundText(result.result, 1000),
          resultWasTruncated:
            result.resultWasTruncated || result.result.length > 1000,
        })),
      ),
    ].join("\n\n");
  }

  addTaskResult(result, options = {}) {
    return this.telemetry.scope(
      {
        taskId: result.taskId ?? result.id,
        inputIds: (result.sourceSequences ?? []).map(
          (n) => `${result.meetingId ?? this.meetingId}:I-${n}`,
        ),
      },
      () => this.#addTaskResultObserved(result, options),
    );
  }

  async #addTaskResultObserved(result, options = {}) {
    while (this.resetting) await this.meetingBoundary;
    if (this.closed)
      throw new VoiceServiceError(
        "SERVICE_STOPPED",
        "Meeting is closed",
        "会議を停止しています。",
      );
    const meetingId = result.meetingId ?? this.meetingId;
    if (meetingId === this.meetingId) {
      const newer = this.results.find(
        (previous) =>
          previous.id === result.id &&
          (previous.runRevision ?? 0) > (result.runRevision ?? 0),
      );
      if (newer) return;
      this.results = this.results.filter(
        (previous) => previous.id !== result.id,
      );
      this.replyContextRevision++;
      this.results.push({
        ...result,
        result: boundText(result.result, 4000),
        resultWasTruncated: String(result.result ?? "").length > 4000,
      });
      this.results = this.results.slice(-20);
      await this.persist();
    }
    while (this.resetting) await this.meetingBoundary;
    if (this.closed)
      throw new VoiceServiceError(
        "SERVICE_STOPPED",
        "Meeting closed before result notification",
        "会議を停止しています。",
      );
    if (options.resultAlreadyDelivered) {
      if (meetingId === this.meetingId) this.#announceTaskResult(result);
      return;
    }
    if (meetingId !== this.meetingId) {
      await this.dependencies.postText(
        this.presentation.meetingResult(result, true),
        options,
      );
      return;
    }
    await this.dependencies.postText(
      this.presentation.meetingResult(result, false),
      options,
    );
    this.#announceTaskResult(result);
  }

  #announceTaskResult(result) {
    if (
      result.superseded ||
      this.dependencies.isLive() ||
      !this.dependencies.revalidateReply
    )
      return;
    const key = `${this.meetingId}:${result.id}:${result.runRevision ?? 0}`;
    if (this.announcedResults.has(key)) return;
    this.announcedResults.add(key);
    if (this.announcedResults.size > 200)
      this.announcedResults.delete(this.announcedResults.values().next().value);
    void this.#queueMeetingSpeech(speechExcerpt(result.result), [
      {
        text: `タスク結果: ${result.title ?? result.id}`,
        resultId: result.id,
        runRevision: result.runRevision ?? 0,
      },
    ]);
  }

  async newMeeting(resetObserver = async () => undefined) {
    if (
      this.closed ||
      this.resetting ||
      this.observing ||
      this.activeQuickReplies ||
      this.pendingSpeechCount ||
      this.activeTextInputs ||
      this.activeTranscriptions ||
      this.audioQueue.length ||
      this.speechTurns.turns.size
    )
      return false;
    this.resetting = true;
    let release;
    this.meetingBoundary = new Promise((resolve) => {
      release = resolve;
    });
    const previous = {
      meetingId: this.meetingId,
      minutes: this.minutes,
      statements: this.statements,
      recentConversation: this.recentConversation,
      results: this.results,
      sequence: this.sequence,
      revision: this.revision,
      silencedThroughSequence: this.silencedThroughSequence,
      memory: this.memory,
      observationRetryPending: this.observationRetryPending,
      observationFailureMessage: this.observationFailureMessage,
    };
    try {
      await this.#archivePendingStatements();
      if (this.statements.some((statement) => !statement.archived))
        return false;
      await withTimeout(
        resetObserver,
        this.stageTimeouts.posting,
        "resetting meeting observer",
        this.shutdownController.signal,
      );
      this.meetingId = randomUUID();
      this.minutes = "";
      this.memory = new MeetingMemory();
      this.statements = [];
      this.recentConversation = [];
      this.results = [];
      this.sequence = 0;
      this.lastReplyDecision = undefined;
      this.silencedThroughSequence = null;
      this.revision = 0;
      this.observationRetryPending = false;
      this.observationFailureMessage = "";
      await this.persist();
      this.#queueLiveUpdate();
      return true;
    } catch (error) {
      Object.assign(this, previous);
      await this.persist().catch(() => undefined);
      this.#log("meeting_reset_failed", { errorCode: voiceErrorCode(error) });
      return false;
    } finally {
      for (const turn of this.speechTurns.turns.values()) {
        if (turn.sequence === undefined) {
          turn.sequence = ++this.sequence;
          turn.meetingId = this.meetingId;
        }
      }
      for (const item of this.audioQueue)
        if (item.sequence === undefined) {
          const turn = this.speechTurns.turns.get(item.metadata.utteranceId);
          if (turn) {
            turn.sequence ??= ++this.sequence;
            turn.meetingId = this.meetingId;
            item.sequence = turn.sequence;
          } else item.sequence = ++this.sequence;
        }
      this.resetting = false;
      release();
      this.#drainTranscriptions();
      this.#scheduleImmediateObservation();
    }
  }

  observeNow() {
    if (this.closed) return Promise.resolve(false);
    return this.#trackOperation(
      this.#observeNow().then(async (result) => {
        // Keep the public completion contract while releasing the observation
        // lock before playback, so the next question can be answered promptly.
        await this.speechQueue;
        return result;
      }),
    );
  }

  #observeNow() {
    return this.telemetry.scope(
      {
        inputIds: this.statements
          .filter((s) => !s.observed)
          .map((s) => `${this.meetingId}:I-${s.sequence}`),
      },
      () => this.#observeNowObserved(),
    );
  }

  async #observeNowObserved() {
    if (this.closed || this.resetting || this.observing) return false;
    this.observing = true;
    if (this.liveUpdatePending) this.#queueLiveUpdate();
    const startedAt = Date.now();
    let analyzingConversation = false;
    try {
      if (this.speechStopSavePending) await this.persist();
      await this.#dispatchPendingControls();
      await this.#archivePendingStatements();
      this.statements = this.statements.filter(
        (statement) => !statement.observed || !statement.archived,
      );
      const statements = [];
      let observationCharacters = 0;
      for (const statement of this.statements.filter(
        (item) => !item.observed,
      )) {
        if (
          statements.length &&
          (observationCharacters + statement.text.length >
            MAX_MEETING_TRANSCRIPT_CHARACTERS ||
            statements.length >= 20)
        )
          break;
        statements.push(statement);
        observationCharacters += statement.text.length;
      }
      if (!statements.length) {
        await this.#dispatchPendingTasks();
        return false;
      }
      const transcript = formatMeetingObservationTranscript(statements);
      const taskVersions = new Map(
        this.getActiveTasks().map((task) => [
          task.id,
          task.controlVersion ?? 0,
        ]),
      );
      this.processingConversation = true;
      analyzingConversation = true;
      this.#queueLiveUpdate();
      const raw = await withTimeout(
        (signal) =>
          this.dependencies.observe(
            {
              meetingId: this.meetingId,
              minutes: this.minutes,
              transcript,
              statements,
              memory: this.memory.context(
                statements.map((statement) => statement.text).join("\n"),
              ),
              ...this.getObservationTaskContext(statements),
              results: this.getObservationResults(statements),
              recentReplies: this.recentConversation
                .filter((item) => item.role === "assistant")
                .map((item) => item.text),
            },
            { signal },
          ),
        this.stageTimeouts.observing ??
          Math.min(this.stageTimeouts.running_codex, 60_000),
        "observing meeting",
        this.shutdownController.signal,
      );
      const observation = parseMeetingObservation(raw, this.minutes);
      const authorizedStatements = statements.map((statement) => ({
        ...statement,
        sourceUserId: statement.userId,
        userId:
          ((this.allParticipantsOperate && Boolean(statement.userId)) ||
            statement.userId === this.ownerUserId ||
            this.operatorUserIds.includes(statement.userId)) &&
          (!this.requireWakeWord ||
            /(?:井戸(?:Bot|ボット)|[いイ][どド](?:ぼっと|ボット)|コーデックス|codex)/iu.test(
              statement.text,
            ))
            ? this.ownerUserId
            : undefined,
      }));
      const tasks = this.tasksEnabled
        ? authorizeMeetingTasks(
            observation.tasks.filter((task) =>
              hasTaskCommitment(task, authorizedStatements, {
                autonomousTasks: this.autonomousTasks,
              }),
            ),
            authorizedStatements,
            this.ownerUserId,
          )
        : [];
      const taskControls = this.tasksEnabled
        ? authorizeMeetingTaskControls(
            observation.taskControls,
            authorizedStatements,
            this.ownerUserId,
          )
        : [];
      await withTimeout(
        (signal) =>
          this.dependencies.upsertMinutes(
            this.presentation.minutes(this.revision + 1, observation.minutes),
            { signal, minutes: observation.minutes },
          ),
        this.stageTimeouts.posting,
        "updating meeting minutes",
        this.shutdownController.signal,
      );
      analyzingConversation = false;
      this.observationRetryPending = false;
      this.observationFailureMessage = "";
      this.minutes = observation.minutes;
      this.memory.update(observation.decisions, statements);
      this.revision += 1;
      for (const task of tasks) {
        const topic = normalizeTaskTopic(task.title);
        if (
          [...this.getActiveTasks(), ...this.pendingTasks].some(
            (existing) =>
              normalizeTaskTopic(existing.title) === topic &&
              !["cancelled", "failed"].includes(existing.state),
          )
        )
          continue;
        // Check late deferrals immediately before dispatch without requiring the
        // entire conversation to stay silent while the observer is working.
        const proposal = observation.tasks.find(
          (candidate) =>
            candidate.title === task.title &&
            candidate.sourceSequences.join(",") ===
              task.sourceSequences.join(","),
        );
        const latestStatements = [
          ...authorizedStatements,
          ...this.statements.filter(
            (statement) =>
              !statements.some(
                (source) => source.sequence === statement.sequence,
              ),
          ),
        ];
        if (
          !hasTaskCommitment(proposal, latestStatements, {
            autonomousTasks: this.autonomousTasks,
          })
        )
          continue;
        task.id = randomUUID().slice(0, 8);
        task.meetingId = this.meetingId;
        task.context = this.getContextSnapshot();
        task.requestKey = `${this.meetingId}:voice:${[...task.sourceSequences].sort((a, b) => a - b).join(",")}`;
        if (
          !this.pendingTasks.some(
            (pending) => pending.requestKey === task.requestKey,
          )
        )
          this.pendingTasks.push(task);
      }
      for (const control of taskControls) {
        control.requestKey = `${this.meetingId}:control:${control.type}:${[...control.sourceSequences].sort((a, b) => a - b).join(",")}`;
        if (!control.taskId) {
          const active = this.getActiveTasks().filter((task) =>
            ["queued", "running", "awaiting_receipt"].includes(task.state),
          );
          if (active.length === 1) control.taskId = active[0].id;
          else
            control.notification =
              "操作対象を一つに特定できません。タスクIDか対象スレッドを指定して再度依頼してください。";
        }
        if (control.type === "instruction")
          control.expectedControlVersion = taskVersions.get(control.taskId);
        if (
          !this.pendingControls.some(
            (pending) => pending.requestKey === control.requestKey,
          )
        )
          this.pendingControls.push(control);
      }
      const conversationReply =
        !observation.tasks.length &&
        !observation.taskControls.length &&
        shouldDeliverObservationReply(
          observation,
          statements,
          this.recentConversation,
        ) &&
        !this.statements.some(
          (statement) =>
            statement.handledAction?.type !== "speech_stop" &&
            statement.sequence >
              Math.max(...statements.map((item) => item.sequence)),
        )
          ? observation.reply
          : "";
      if (conversationReply)
        this.pendingControls.push({
          type: "reply",
          meetingId: this.meetingId,
          requestKey: `${this.meetingId}:reply:${this.revision}`,
          sourceSequences: observation.replySourceSequences,
          participantUserIds: [
            ...new Set(
              statements
                .filter((statement) =>
                  observation.replySourceSequences.includes(statement.sequence),
                )
                .map((statement) => statement.userId)
                .filter(Boolean),
            ),
          ],
          notification: conversationReply,
          speechTargets: statements
            .filter((s) =>
              observation.replySourceSequences.includes(s.sequence),
            )
            .map(({ sequence, text }) => ({ sequence, text })),
          spokenNotification:
            statements.some(
              (statement) =>
                observation.replySourceSequences.includes(statement.sequence) &&
                mayReplyImmediately(statement),
            ) &&
            this.#canSpeakFor(
              statements
                .filter((statement) => !statement.handledAction)
                .map((statement) => statement.sequence),
            )
              ? speechExcerpt(conversationReply)
              : "",
        });
      for (const statement of statements) statement.observed = true;
      this.statements = this.statements.filter(
        (statement) => !statement.observed || !statement.archived,
      );
      await this.persist();
      this.droppedAudio = 0;
      this.failedTranscriptions = 0;
      this.#queueLiveUpdate();

      await this.#dispatchPendingControls();
      const { accepted: acceptedTasks } = await this.#dispatchPendingTasks();

      this.#log("meeting_observation_completed", {
        elapsedMs: Date.now() - startedAt,
        statements: statements.length,
        replied: Boolean(conversationReply),
        tasks: acceptedTasks.length,
      });
      if (
        this.statements.some(
          (statement) =>
            !statement.observed &&
            !statement.handledAction &&
            mayReplyImmediately(statement, this.immediateReactions),
        )
      )
        this.immediateObservationRequested = true;
      return true;
    } catch (error) {
      if (!this.closed) {
        if (analyzingConversation) {
          this.observationRetryPending = true;
          this.observationFailureMessage =
            error instanceof VoiceServiceError
              ? boundText(error.publicMessage ?? "", 160)
              : "";
        }
        this.#log("meeting_observation_failed", {
          elapsedMs: Date.now() - startedAt,
          errorCode: voiceErrorCode(error),
        });
      }
      return false;
    } finally {
      this.observing = false;
      if (this.processingConversation) {
        this.processingConversation = false;
        this.#queueLiveUpdate();
      }
      this.#scheduleImmediateObservation();
    }
  }

  async #applyMeetingControl(control) {
    return (
      (control.type === "stop" &&
        (await this.cancelPendingTask(control.taskId))) ||
      this.dependencies.controlTask(control)
    );
  }

  #dispatchPendingControls() {
    if (!this.controlsDispatching)
      this.controlsDispatching = this.#flushPendingControls().finally(() => {
        this.controlsDispatching = undefined;
      });
    return this.controlsDispatching;
  }

  async #flushPendingControls() {
    if (this.pendingControls.length) await this.persist();
    for (const control of [...this.pendingControls]) {
      if (this.closed) break;
      try {
        if (!control.notification) {
          const result = await withTimeout(
            () => this.#applyMeetingControl(control),
            this.stageTimeouts.posting,
            "saving task control",
            this.shutdownController.signal,
          );
          if (result?.persisted === false)
            throw new Error("Control state save pending");
          control.notification = controlReceiptText(control, result);
          await this.persist();
        }
        this.controlsAttempted.add(control);
        const chunks = this.presentation.splitText(control.notification);
        const replyContext =
          control.type === "reply" && control.meetingId !== this.meetingId
            ? control.meetingId
              ? "以前の会議への回答"
              : "保存済みの回答"
            : "";
        for (
          let index = control.deliveredChunks ?? 0;
          index < chunks.length;
          index += 1
        ) {
          await withTimeout(
            (signal) =>
              this.dependencies.postText(
                replyContext
                  ? this.presentation.replyContext(replyContext, chunks[index])
                  : chunks[index],
                {
                  signal,
                  taskId: control.taskId,
                  participantUserIds: control.participantUserIds,
                  idempotencyKey: control.requestKey
                    ? `${control.requestKey}:text:${index}`
                    : undefined,
                },
              ),
            this.stageTimeouts.posting,
            "posting saved meeting notification",
            this.shutdownController.signal,
          );
          control.deliveredChunks = index + 1;
          await this.persist();
        }
        if (control.type === "reply" && control.notification) {
          this.replyContextRevision++;
          this.recentConversation.push({
            role: "assistant",
            sourceSequences: control.sourceSequences,
            text: boundText(control.notification, 1200),
          });
          this.recentConversation = this.recentConversation.slice(-24);
        }
        this.pendingControls = this.pendingControls.filter(
          (pending) => pending !== control,
        );
        await this.persist();
        // Receipts and ordinary progress stay in text; only actual answers speak.
        const excerpt = ["reply", "status"].includes(control.type)
          ? (control.spokenNotification ?? control.notification)
          : "";
        const spoken =
          excerpt && replyContext ? `${replyContext}です。${excerpt}` : excerpt;
        // Text delivery must not wait for an earlier spoken response.
        void this.#queueMeetingSpeech(
          this.#canSpeakFor(control.sourceSequences) ? spoken : "",
          control.speechTargets ??
            this.recentConversation.filter(
              (item) =>
                item.role === "user" &&
                control.sourceSequences?.includes(item.sequence),
            ),
        );
      } catch (error) {
        this.#log("meeting_control_dispatch_pending", {
          requestKey: control.requestKey,
          errorCode: voiceErrorCode(error),
        });
      }
    }
  }

  #canSpeakFor(sequences) {
    return (
      this.silencedThroughSequence === null ||
      (sequences ?? []).some(
        (sequence) => sequence > this.silencedThroughSequence,
      )
    );
  }

  #queueMeetingSpeech(spoken, targets = []) {
    if (!this.speechEnabled || !spoken || this.closed || this.voicePaused)
      return Promise.resolve();
    if (this.dependencies.isLive()) {
      this.dependencies.speak(spoken);
      return Promise.resolve();
    }
    const speechSignal = AbortSignal.any([
      this.shutdownController.signal,
      this.speechController.signal,
    ]);
    const key = targets
      .map((target) =>
        target.text
          .normalize("NFKC")
          .replace(/[\s、。！？!?]/gu, " ")
          .trim(),
      )
      .join("\n");
    const order = Math.max(
      -1,
      ...targets.map((target) => target.sequence ?? -1),
    );
    const historyKey = `${this.meetingId}:${key}`;
    if (key && (this.latestSpeechOrders.get(historyKey) ?? -1) > order)
      return Promise.resolve();
    if (key) this.latestSpeechOrders.set(historyKey, order);
    if (this.latestSpeechOrders.size > 200)
      this.latestSpeechOrders.delete(
        this.latestSpeechOrders.keys().next().value,
      );
    const candidate = { order };
    if (key) this.speechCandidates.set(key, candidate);
    const ticket = createSpeechTicket({
      isCurrent: () =>
        (!key || this.speechCandidates.get(key) === candidate) &&
        targets.every((target) => {
          if (!target.resultId) return true;
          const current = this.results.find(
            (result) => result.id === target.resultId,
          );
          return (
            current &&
            !current.superseded &&
            (current.runRevision ?? 0) === target.runRevision
          );
        }),
      text: spoken,
      targets,
      validate: this.dependencies.revalidateReply
        ? async (input, options) => {
            const decision = await this.dependencies.revalidateReply(
              input,
              options,
            );
            this.#log("meeting_speech_revalidated", {
              decision: decision.decision,
              sourceSequences: targets
                .map((t) => t.sequence)
                .filter(Number.isInteger),
            });
            return decision;
          }
        : undefined,
      getState: () => ({
        revision: this.replyContextRevision,
        pendingTranscripts:
          this.activeTranscriptions +
          this.audioQueue.length +
          this.speechTurns.turns.size +
          this.activeTextInputs,
        conversation: this.recentConversation.filter(
          (item) =>
            !targets.some(
              (target) =>
                target.sequence === item.sequence ||
                item.sourceSequences?.includes(target.sequence),
            ),
        ),
      }),
    });
    const finishWait = this.telemetry.span("TTS", {
      status: "waiting",
      reason: "playback_queue",
    });
    this.pendingSpeechCount++;
    this.speechQueue = this.speechQueue
      .then(() => {
        finishWait(speechSignal.aborted ? "interrupted" : "completed");
        return deliverSpeech(spoken, {
          synthesize: this.dependencies.synthesize,
          playAudio: this.dependencies.playAudio,
          stageTimeouts: this.stageTimeouts,
          signal: speechSignal,
          beforeStart: ticket.beforeStart,
          canStart: ticket.canStart,
        });
      })
      .catch((error) => {
        if (!this.closed && error?.code !== "SPEECH_STOPPED")
          this.#log("meeting_speech_failed", {
            errorCode: voiceErrorCode(error),
          });
      })
      .finally(() => {
        this.pendingSpeechCount--;
        if (key && this.speechCandidates.get(key) === candidate)
          this.speechCandidates.delete(key);
      });
    return this.#trackOperation(this.speechQueue);
  }

  async #dispatchPendingTasks() {
    const accepted = [];
    if (this.pendingTasks.length) await this.persist();
    for (const task of [...this.pendingTasks]) {
      if (this.closed) break;
      try {
        if (
          this.dependencies.getTaskReceipt(task.requestKey)?.state ===
          "cancelled"
        )
          task.cancelled = true;
        if (!task.cancelled && !task.rejectionReason) {
          const dispatched = await withTimeout(
            () => this.dependencies.enqueueTask(task),
            this.stageTimeouts.posting,
            "saving task receipt",
            this.shutdownController.signal,
          );
          if (
            this.dependencies.getTaskReceipt(task.requestKey)?.state ===
            "cancelled"
          )
            task.cancelled = true;
          if (!dispatched) {
            task.rejectionReason = "queue_full";
            await this.persist();
          }
        }
        if (task.cancelled) {
          const result = await this.#savePendingCancellation(task);
          if (result.persisted === false)
            throw new Error("Cancellation save pending");
        } else if (task.rejectionReason) {
          await withTimeout(
            (signal) =>
              this.dependencies.postText(
                `⚠️ 作業枠が満杯のため「${this.presentation.escapeText(task.title)}」を開始していません。空きができたら再度依頼してください。`,
                { signal },
              ),
            this.stageTimeouts.posting,
            "posting task rejection",
            this.shutdownController.signal,
          );
        } else accepted.push(task);
        this.pendingTasks = this.pendingTasks.filter(
          (pending) => pending !== task,
        );
        await this.persist();
      } catch (error) {
        this.#log("meeting_task_dispatch_pending", {
          requestKey: task.requestKey,
          errorCode: voiceErrorCode(error),
        });
        if (
          !task.cancelled &&
          !task.rejectionReason &&
          !task.retryNoticeSent &&
          !this.closed
        ) {
          try {
            await withTimeout(
              (signal) =>
                this.dependencies.postText(
                  this.presentation.pendingReceipt(task),
                  { signal },
                ),
              this.stageTimeouts.posting,
              "posting receipt retry status",
              this.shutdownController.signal,
            );
            task.retryNoticeSent = true;
            await this.persist();
          } catch {
            /* The pending request remains visible in task status. */
          }
        }
      }
    }
    return { accepted };
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.closed = true;
    this.cancelInterval(this.interval);
    for (const item of this.audioQueue) {
      this.telemetry.emit({
        stage: "STT",
        spanId: `stt-wait-${item.id}-${item.metadata.segmentIndex ?? 0}`,
        status: "interrupted",
        reason: "service_stopped",
        inputIds: [`${this.meetingId}:I-${item.sequence}`],
      });
      this.telemetry.emit({
        stage: "ASSEMBLE",
        spanId: `input-${this.meetingId}-${item.sequence}`,
        status: "interrupted",
        reason: "service_stopped",
        inputIds: [`${this.meetingId}:I-${item.sequence}`],
      });
    }
    this.audioQueue = [];
    this.shutdownController.abort(
      new VoiceServiceError(
        "SERVICE_STOPPED",
        "Voice meeting session stopped.",
        "音声サービスを停止しました。",
      ),
    );
    this.stopping = (async () => {
      await this.meetingBoundary;
      await Promise.allSettled([
        ...this.activeOperations,
        ...this.activeTranscriptionJobs,
      ]);
      await this.liveUpdate;
      try {
        this.speechTurns.interrupt();
        await this.#flushSpeechTurns();
        await this.#archivePendingStatements();
        await this.persist();
      } finally {
        await this.dependencies.closeTranscriptArchive();
      }
    })();
    return this.stopping;
  }

  #trackOperation(operation) {
    this.activeOperations.add(operation);
    void operation
      .finally(() => this.activeOperations.delete(operation))
      .catch(() => undefined);
    return operation;
  }

  #drainTranscriptions() {
    while (
      !this.closed &&
      !this.resetting &&
      this.activeTranscriptions < this.transcriptionConcurrency &&
      this.audioQueue.length
    ) {
      const item = this.audioQueue.shift();
      this.#recordQueuedAudio(item);
      this.telemetry.emit({
        stage: "STT",
        spanId: `stt-wait-${item.id}-${item.metadata.segmentIndex ?? 0}`,
        status: "completed",
        inputIds: [`${this.meetingId}:I-${item.sequence}`],
      });
      this.activeTranscriptions += 1;
      const job = this.#transcribeItem(item);
      this.activeTranscriptionJobs.add(job);
      void job.finally(() => {
        this.activeTranscriptionJobs.delete(job);
        this.activeTranscriptions -= 1;
        this.#drainTranscriptions();
      });
    }
  }

  #transcribeItem(item) {
    return this.telemetry.scope(
      {
        inputIds: [`${this.meetingId}:I-${item.sequence}`],
        parentId: item.metadata.utteranceId,
      },
      () => this.#transcribeItemObserved(item),
    );
  }

  async #transcribeItemObserved(item) {
    const startedAt = Date.now();
    let accepted = false;
    let segmentSettled = false;
    try {
      const text = boundText(
        await withTimeout(
          (signal) => this.dependencies.transcribe(item.wav, { signal }),
          this.stageTimeouts.transcribing,
          "transcribing meeting audio",
          this.shutdownController.signal,
        ),
        MAX_TRANSCRIPT_CHARACTERS,
      );
      if (!text) {
        if (item.metadata.utteranceId) {
          this.speechTurns.settle(
            item.metadata.utteranceId,
            item.metadata.segmentIndex,
            { text: "", archived: true },
          );
          segmentSettled = true;
          await this.#flushSpeechTurns();
        }
        this.#log("meeting_transcript_discarded", {
          sequence: item.sequence,
          elapsedMs: Date.now() - startedAt,
          reason: "empty_transcript",
        });
        return;
      }
      const statement = {
        id: item.id,
        inputId: item.metadata.inputId,
        taskId: item.metadata.taskId,
        requestKey: item.metadata.requestKey,
        taskEligible: item.metadata.taskEligible !== false,
        requestReply: item.metadata.requestReply === true,
        meetingId: this.meetingId,
        sequence: item.sequence,
        userId: item.metadata.userId,
        speakerName: item.metadata.speakerName,
        startedAt: item.metadata.startedAt ?? item.queuedAt,
        text,
        observed: false,
        archived: false,
      };
      if (item.metadata.utteranceId) {
        statement.utteranceId = item.metadata.utteranceId;
        statement.segmentIndex = item.metadata.segmentIndex;
        await this.#archiveStatement(statement);
        this.speechTurns.settle(
          item.metadata.utteranceId,
          item.metadata.segmentIndex,
          statement,
        );
        segmentSettled = true;
        await this.#flushSpeechTurns();
      } else {
        this.statements.push(statement);
        await this.#tryImmediateTaskAction(statement);
        await this.#archiveStatement(statement);
        await this.persist();
      }
      this.#log("meeting_transcript_completed", {
        sequence: item.sequence,
        elapsedMs: Date.now() - startedAt,
        transcriptCharacters: text.length,
      });
      accepted = true;
    } catch (error) {
      if (!this.closed) {
        this.failedTranscriptions += 1;
        this.#log("meeting_transcript_failed", {
          sequence: item.sequence,
          elapsedMs: Date.now() - startedAt,
          errorCode: voiceErrorCode(error),
        });
      }
    } finally {
      if (!accepted)
        this.telemetry.emit({
          stage: "ASSEMBLE",
          spanId: `input-${this.meetingId}-${item.sequence}`,
          status: this.closed
            ? "interrupted"
            : segmentSettled
              ? "skipped"
              : "failed",
          reason: this.closed ? "service_stopped" : "transcript_unavailable",
        });
      if (item.metadata.utteranceId && !segmentSettled) {
        this.speechTurns.settle(
          item.metadata.utteranceId,
          item.metadata.segmentIndex,
          undefined,
        );
        await this.#flushSpeechTurns().catch(() => undefined);
      }
      this.#queueLiveUpdate();
      if (
        accepted &&
        this.statements.some(
          (statement) =>
            !statement.observed &&
            !statement.handledAction &&
            mayReplyImmediately(statement, this.immediateReactions),
        )
      ) {
        this.immediateObservationRequested = true;
        this.liveUpdate.finally(() => this.#scheduleImmediateObservation());
      }
    }
  }

  #queueLiveUpdate() {
    if (this.closed) return;
    const statements = this.statements.filter(
      (statement) => !statement.observed,
    );
    const notices = [];
    if (this.lastReplyDecision)
      notices.push(
        `直近の発言 #${this.lastReplyDecision.sequence}: ${this.lastReplyDecision.decision}`,
      );
    if (this.activeInvestigations)
      notices.push(
        `質問のソース・実行状態を確認中 ${this.activeInvestigations}件`,
      );
    if (this.processingConversation)
      notices.push("会話を処理中。続けて話せます");
    else if (this.observationRetryPending && statements.length) {
      notices.push("会話の確認に失敗。次の確認で再試行します");
      if (this.observationFailureMessage)
        notices.push(this.observationFailureMessage);
    }
    if (this.speechTurns.turns.size)
      notices.push(
        `${this.speechTurns.turns.size}件の発話を認識中。話し終わってから依頼を処理します`,
      );
    if (this.droppedAudio) notices.push(`未処理音声 ${this.droppedAudio} 件`);
    if (this.failedTranscriptions)
      notices.push(`認識失敗 ${this.failedTranscriptions} 件`);
    if (this.archiveFailures)
      notices.push(`保存再試行待ち ${this.archiveFailures} 件`);
    const status = this.presentation.liveStatus(notices);
    const content =
      this.presentation.formatTranscript(
        statements,
        Math.min(
          this.presentation.maximumTranscript,
          this.presentation.maximumText - status.length,
        ),
      ) + status;
    this.pendingLiveContent = content;
    if (this.liveUpdateRunning) return;
    this.liveUpdateRunning = true;
    this.liveUpdate = this.#flushLiveUpdates();
  }

  async #flushLiveUpdates() {
    try {
      while (this.pendingLiveContent !== undefined && !this.closed) {
        const content = this.pendingLiveContent;
        this.pendingLiveContent = undefined;
        await withTimeout(
          (signal) =>
            this.dependencies.upsertLiveTranscript(content, { signal }),
          this.stageTimeouts.posting,
          "updating live transcript",
          this.shutdownController.signal,
        );
        this.liveUpdatePending = false;
      }
    } catch (error) {
      this.liveUpdatePending = true;
      if (!this.closed)
        this.#log("meeting_live_update_failed", {
          errorCode: voiceErrorCode(error),
        });
    } finally {
      this.liveUpdateRunning = false;
    }
  }

  #archiveStatement(statement) {
    if (statement.archived) return Promise.resolve(true);
    if (this.archiveOperations.has(statement))
      return this.archiveOperations.get(statement);
    const operation = this.#writeArchiveStatement(statement);
    this.archiveOperations.set(statement, operation);
    void operation
      .finally(() => this.archiveOperations.delete(statement))
      .catch(() => undefined);
    return operation;
  }

  async #writeArchiveStatement(statement) {
    if (statement.archiveParts) {
      for (const part of statement.archiveParts)
        await this.#archiveStatement(part);
      statement.archived = statement.archiveParts.every(
        (part) => part.archived,
      );
      if (statement.archived) delete statement.archiveParts;
      return statement.archived;
    }
    try {
      await this.dependencies.archiveTranscript(statement);
      statement.archived = true;
      this.archiveFailures = this.statements.filter(
        (candidate) => !candidate.archived,
      ).length;
      return true;
    } catch (error) {
      this.archiveFailures = this.statements.filter(
        (candidate) => !candidate.archived,
      ).length;
      this.#log("meeting_transcript_archive_failed", {
        sequence: statement.sequence,
        errorCode: voiceErrorCode(error),
      });
      return false;
    }
  }

  async #archivePendingStatements() {
    const pending = this.statements.filter((statement) => !statement.archived);
    for (const statement of pending) await this.#archiveStatement(statement);
  }

  #scheduleImmediateObservation() {
    if (
      this.closed ||
      this.observing ||
      !this.immediateObservationRequested ||
      this.immediateObservationScheduled
    )
      return;
    this.immediateObservationScheduled = true;
    queueMicrotask(async () => {
      this.immediateObservationScheduled = false;
      if (this.closed || this.observing) return;
      this.immediateObservationRequested = false;
      await this.observeNow();
      this.#scheduleImmediateObservation();
    });
  }

  #log(event, detail) {
    try {
      this.logger.info?.({
        component: "conversation-engine",
        event,
        ...detail,
      });
    } catch {
      // Meeting capture must not depend on logging.
    }
  }
}
