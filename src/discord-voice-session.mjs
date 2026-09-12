import { randomUUID } from "node:crypto";
import { SpeechTurnAssembler } from "./discord-voice-utterances.mjs";
import { formatVerificationEvidence } from "./discord-voice-evidence.mjs";
import {
  VoiceServiceError,
  voiceErrorCode,
  voiceErrorMessage,
} from "./discord-voice-errors.mjs";

const MAX_DISCORD_MESSAGE = 1_900;
const MAX_TRANSCRIPT_CHARACTERS = 8_000;
const MAX_CODEX_RESPONSE_CHARACTERS = 12_000;
const TRUNCATION_SUFFIX = " …（長さ上限で省略）";
const UNCONFIRMED_INSTRUCTION_PREFIX =
  "中断前の追加指示は完了未確認です。履歴と作業場所を確認し、実行済みの外部操作を繰り返さず、未完了分だけ続けてください。\n";
function retainInterruptedInstruction(task, entry, uncertain = true) {
  const text = typeof entry === "string" ? entry : entry?.text;
  if (!text) return;
  task.instructions.unshift({
    id: typeof entry === "object" ? entry.id : randomUUID(),
    text:
      uncertain && !text.startsWith(UNCONFIRMED_INSTRUCTION_PREFIX)
        ? UNCONFIRMED_INSTRUCTION_PREFIX + text
        : text,
  });
  task.additionalInstruction = undefined;
}
const DEFAULT_STAGE_TIMEOUTS = Object.freeze({
  transcribing: 120_000,
  running_codex: 900_000,
  posting: 30_000,
  synthesizing: 120_000,
  speaking: 300_000,
});

function safeSliceEnd(text, end) {
  if (end <= 0 || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
    ? end - 1
    : end;
}

export async function withTimeout(operation, timeoutMs, label, parentSignal) {
  if (parentSignal?.aborted) {
    throw (
      parentSignal.reason ??
      new VoiceServiceError(
        "SERVICE_STOPPED",
        `${label} cancelled because the voice service stopped.`,
        "音声サービスを停止しました。",
      )
    );
  }
  const controller = new AbortController();
  let timer;
  let removeParentAbort = () => undefined;
  try {
    const parentAbort = new Promise((_, reject) => {
      if (!parentSignal) return;
      const abort = () => {
        const reason =
          parentSignal.reason ??
          new VoiceServiceError(
            "SERVICE_STOPPED",
            `${label} cancelled because the voice service stopped.`,
            "音声サービスを停止しました。",
          );
        controller.abort(reason);
        reject(reason);
      };
      if (parentSignal.aborted) {
        abort();
        return;
      }
      parentSignal.addEventListener("abort", abort, { once: true });
      removeParentAbort = () =>
        parentSignal.removeEventListener("abort", abort);
    });
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      parentAbort,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const timeout = new VoiceServiceError(
            "STAGE_TIMEOUT",
            `${label} timed out after ${timeoutMs}ms`,
            "処理が制限時間を超えました。次の発話を受け付けます。",
          );
          reject(timeout);
          controller.abort(timeout);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    removeParentAbort();
  }
}

export function boundText(text, maximum, suffix = TRUNCATION_SUFFIX) {
  if (!Number.isInteger(maximum) || maximum <= 0) return "";
  const normalized = String(text ?? "").trim();
  if (normalized.length <= maximum) return normalized;
  const safeSuffix = suffix.length < maximum ? suffix : "";
  const end = safeSliceEnd(normalized, maximum - safeSuffix.length);
  return `${normalized.slice(0, end).trimEnd()}${safeSuffix}`;
}

function boundRecentText(text, maximum) {
  const normalized = String(text ?? "").trim();
  if (normalized.length <= maximum) return normalized;
  const prefix = "（前半を省略。以下は最新の内容）\n";
  let start = normalized.length - (maximum - prefix.length);
  const first = normalized.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start++;
  return prefix + normalized.slice(start);
}

export function splitDiscordText(text, maximum = MAX_DISCORD_MESSAGE) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return [];
  if (!Number.isInteger(maximum) || maximum < 2) return [normalized];
  const chunks = [];
  let remaining = normalized;
  while (remaining.length > maximum) {
    let cut = remaining.lastIndexOf("\n", maximum - 1);
    if (cut < maximum * 0.5) cut = remaining.lastIndexOf("。", maximum - 1);
    if (cut < maximum * 0.5) cut = remaining.lastIndexOf(" ", maximum - 1);
    if (cut < maximum * 0.5) cut = maximum;
    else cut += 1;
    cut = safeSliceEnd(remaining, cut);
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function speechExcerpt(text, maximum = 1_200) {
  if (!Number.isInteger(maximum) || maximum <= 0) return "";
  const normalized = String(text ?? "")
    .replace(/https?:\/\/\S+/g, "リンク")
    .trim();
  if (normalized.length <= maximum) return normalized;
  const safeSuffix =
    TRUNCATION_SUFFIX.length < maximum ? TRUNCATION_SUFFIX : "";
  const budget = maximum - safeSuffix.length;
  const candidate = normalized.slice(0, safeSliceEnd(normalized, budget));
  const boundary = Math.max(
    candidate.lastIndexOf("。"),
    candidate.lastIndexOf("\n"),
  );
  const excerpt = candidate.slice(
    0,
    boundary > budget * 0.6 ? boundary + 1 : budget,
  );
  return `${excerpt.trimEnd()}${safeSuffix}`;
}

export class DiscordVoiceSession {
  constructor({
    transcribe,
    runCodex,
    synthesize,
    postText,
    playAudio,
    logger = console,
    maximumQueuedTurns = 3,
    stageTimeouts = {},
  }) {
    this.dependencies = {
      transcribe,
      runCodex,
      synthesize,
      postText,
      playAudio,
    };
    this.logger = logger;
    this.maximumQueuedTurns = maximumQueuedTurns;
    this.stageTimeouts = { ...DEFAULT_STAGE_TIMEOUTS, ...stageTimeouts };
    this.queue = [];
    this.processing = false;
    this.state = "idle";
    this.closed = false;
    this.shutdownController = new AbortController();
    this.stoppedAtStage = undefined;
  }

  enqueue(wav, metadata = {}) {
    if (!Buffer.isBuffer(wav)) throw new TypeError("wav must be a Buffer");
    if (this.closed) return false;
    if (this.queue.length >= this.maximumQueuedTurns) return false;
    this.queue.push({ id: randomUUID(), wav, metadata, queuedAt: Date.now() });
    if (!this.processing) this.processingOperation = this.#drain();
    return true;
  }

  async #drain() {
    if (this.processing) return;
    this.processing = true;
    while (this.queue.length) {
      const turn = this.queue.shift();
      await this.#processTurn(turn);
    }
    this.state = this.closed ? "stopped" : "idle";
    this.processing = false;
  }

  stop() {
    if (this.closed) return this.processingOperation;
    this.closed = true;
    this.queue = [];
    this.stoppedAtStage = this.state;
    this.state = "stopped";
    this.shutdownController.abort(
      new VoiceServiceError(
        "SERVICE_STOPPED",
        "Discord voice session stopped.",
        "音声サービスを停止しました。",
      ),
    );
    return this.processingOperation;
  }

  async #processTurn(turn) {
    const startedAt = Date.now();
    try {
      this.state = "transcribing";
      const transcript = boundText(
        await withTimeout(
          (signal) => this.dependencies.transcribe(turn.wav, { signal }),
          this.stageTimeouts.transcribing,
          "transcribing",
          this.shutdownController.signal,
        ),
        MAX_TRANSCRIPT_CHARACTERS,
      );
      if (!transcript) {
        this.#log("discarded", turn, startedAt, { reason: "empty_transcript" });
        return;
      }
      const transcriptChunks = splitDiscordText(
        `🎙️ **聞き取った内容**\n${transcript}`,
      );
      this.state = "posting_transcript";
      for (const chunk of transcriptChunks) {
        await withTimeout(
          (signal) => this.dependencies.postText(chunk, { signal }),
          this.stageTimeouts.posting,
          "posting transcript",
          this.shutdownController.signal,
        );
      }

      this.state = "running_codex";
      const response = boundText(
        await withTimeout(
          (signal) => this.dependencies.runCodex(transcript, { signal }),
          this.stageTimeouts.running_codex,
          "running_codex",
          this.shutdownController.signal,
        ),
        MAX_CODEX_RESPONSE_CHARACTERS,
      );
      const chunks = splitDiscordText(
        response || "Codexから空の応答が返りました。",
      );
      this.state = "posting_response";
      for (const chunk of chunks) {
        await withTimeout(
          (signal) => this.dependencies.postText(chunk, { signal }),
          this.stageTimeouts.posting,
          "posting response",
          this.shutdownController.signal,
        );
      }

      const spoken = speechExcerpt(response);
      if (spoken) {
        this.state = "synthesizing";
        const audio = await withTimeout(
          (signal) => this.dependencies.synthesize(spoken, { signal }),
          this.stageTimeouts.synthesizing,
          "synthesizing",
          this.shutdownController.signal,
        );
        this.state = "speaking";
        await withTimeout(
          (signal) => this.dependencies.playAudio(audio, { signal }),
          this.stageTimeouts.speaking,
          "speaking",
          this.shutdownController.signal,
        );
      }
      this.#log("completed", turn, startedAt, {
        transcriptCharacters: transcript.length,
        responseCharacters: response.length,
      });
    } catch (error) {
      if (this.closed) {
        this.#log("cancelled", turn, startedAt, {
          stage: this.stoppedAtStage ?? this.state,
          errorCode: voiceErrorCode(error),
        });
        return;
      }
      this.#log("failed", turn, startedAt, {
        stage: this.state,
        errorCode: voiceErrorCode(error),
      });
      await withTimeout(
        (signal) =>
          this.dependencies.postText(
            `⚠️ 音声ターンを完了できませんでした（${this.state}）。${voiceErrorMessage(error)}`,
            { signal },
          ),
        this.stageTimeouts.posting,
        "posting error",
        this.shutdownController.signal,
      ).catch(() => undefined);
    }
  }

  #log(event, turn, startedAt, detail) {
    try {
      this.logger.info?.({
        component: "discord-voice",
        event,
        turnId: turn.id,
        elapsedMs: Date.now() - startedAt,
        ...detail,
      });
    } catch {
      // Logging must never stop the serialized voice queue.
    }
  }
}

const MAX_MEETING_MINUTES_CHARACTERS = 10_000;
const MAX_MEETING_TRANSCRIPT_CHARACTERS = 16_000;
const MAX_LIVE_TRANSCRIPT_CHARACTERS = 1_850;

export function escapeDiscordMarkdown(value) {
  return String(value ?? "").replace(/([\\`*_{}[\]()#+.!|>~-])/g, "\\$1");
}

function speakerLabel(statement) {
  return boundText(
    String(statement.speakerName ?? statement.userId ?? "不明な話者")
      .replace(/[\r\n]+/g, " ")
      .trim(),
    80,
    "…",
  );
}

export function formatMeetingTranscript(
  statements,
  maximum = MAX_LIVE_TRANSCRIPT_CHARACTERS,
) {
  const ordered = [...statements].sort(
    (left, right) =>
      (left.startedAt ?? 0) - (right.startedAt ?? 0) ||
      (left.sequence ?? 0) - (right.sequence ?? 0),
  );
  const lines = ordered.map(
    (statement) =>
      `**${escapeDiscordMarkdown(speakerLabel(statement))}**: ${statement.text}`,
  );
  const header = "🎙️ **会話中（次回の定期観測まで）**";
  const kept = [];
  let used = header.length;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (used + line.length + 1 > maximum) break;
    kept.unshift(line);
    used += line.length + 1;
  }
  const omitted = lines.length - kept.length;
  const body = kept.length ? kept.join("\n") : "_発話を待っています。_";
  return `${header}\n${omitted ? `_古い発話 ${omitted} 件は会話ログへ保存しました。_\n` : ""}${body}`;
}

export function formatMeetingObservationTranscript(statements) {
  const ordered = [...statements].sort(
    (left, right) =>
      (left.startedAt ?? 0) - (right.startedAt ?? 0) ||
      (left.sequence ?? 0) - (right.sequence ?? 0),
  );
  const transcript = ordered
    .map((statement) => `[${speakerLabel(statement)}] ${statement.text}`)
    .join("\n");
  return boundRecentText(transcript, MAX_MEETING_TRANSCRIPT_CHARACTERS);
}

export function parseMeetingObservation(value, fallbackMinutes = "") {
  const text = String(value ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate =
    fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new VoiceServiceError(
      "MEETING_OBSERVATION_INVALID",
      "Meeting observation did not return valid JSON.",
      "会議の観測結果を整理できませんでした。次回の観測で再試行します。",
      { cause: error },
    );
  }
  const minutes =
    boundText(parsed?.minutes, MAX_MEETING_MINUTES_CHARACTERS) ||
    boundText(fallbackMinutes, MAX_MEETING_MINUTES_CHARACTERS) ||
    "まだ議事録に残す要点はありません。";
  const reply = boundText(parsed?.reply, MAX_CODEX_RESPONSE_CHARACTERS);
  const tasks = Array.isArray(parsed?.tasks)
    ? parsed.tasks.slice(0, 3).map((task) => ({
        title: boundText(task?.title, 120, "…") || "Codexタスク",
        kind: task?.kind ?? "implementation",
        complexity: task?.complexity ?? "routine",
        sourceSequences: Array.isArray(task?.sourceSequences)
          ? [
              ...new Set(
                task.sourceSequences.filter(
                  (sequence) => Number.isInteger(sequence) && sequence > 0,
                ),
              ),
            ].slice(0, 20)
          : [],
      }))
    : [];
  const taskControls = Array.isArray(parsed?.taskControls)
    ? parsed.taskControls.slice(0, 3).map((control) => ({
        taskId: typeof control.taskId === "string" ? control.taskId : undefined,
        type:
          control?.type === "stop" || control?.type === "instruction"
            ? control.type
            : undefined,
        sourceSequences: Array.isArray(control?.sourceSequences)
          ? [
              ...new Set(
                control.sourceSequences.filter(
                  (sequence) => Number.isInteger(sequence) && sequence > 0,
                ),
              ),
            ].slice(0, 20)
          : [],
      }))
    : [];
  return {
    minutes,
    shouldReply: parsed?.shouldReply === true && Boolean(reply),
    reply,
    tasks,
    taskControls,
  };
}

export function authorizeMeetingTaskControls(
  controls,
  statements,
  ownerUserId,
) {
  if (!ownerUserId || !Array.isArray(controls) || !Array.isArray(statements))
    return [];
  const bySequence = new Map(
    statements.map((statement) => [statement.sequence, statement]),
  );
  return controls.flatMap((control) => {
    const sources = control.sourceSequences
      .map((sequence) => bySequence.get(sequence))
      .filter(Boolean);
    if (
      !control.type ||
      !sources.length ||
      sources.length !== control.sourceSequences.length ||
      sources.some(
        (statement) =>
          statement.userId !== ownerUserId || statement.taskEligible === false,
      )
    )
      return [];
    const instruction = sources
      .map((statement) => statement.text)
      .join("\n")
      .trim();
    return instruction
      ? [
          {
            type: control.type,
            instruction,
            sourceSequences: [...control.sourceSequences],
            ...(control.taskId ? { taskId: control.taskId } : {}),
          },
        ]
      : [];
  });
}

export function authorizeMeetingTasks(tasks, statements, ownerUserId) {
  if (!ownerUserId || !Array.isArray(tasks) || !Array.isArray(statements))
    return [];
  const bySequence = new Map(
    statements.map((statement) => [statement.sequence, statement]),
  );
  const context = formatMeetingObservationTranscript(statements);
  const authorizedSources = new Set();
  return tasks.flatMap((task) => {
    const sources = task.sourceSequences
      .map((sequence) => bySequence.get(sequence))
      .filter(Boolean);
    if (
      !sources.length ||
      sources.length !== task.sourceSequences.length ||
      sources.some(
        (statement) =>
          statement.userId !== ownerUserId || statement.taskEligible === false,
      )
    ) {
      return [];
    }
    const sourceKey = [...task.sourceSequences].sort((a, b) => a - b).join(",");
    if (authorizedSources.has(sourceKey)) return [];
    authorizedSources.add(sourceKey);
    const request = sources
      .map((statement) => statement.text)
      .join("\n")
      .trim();
    if (!request) return [];
    return [
      {
        title: task.title,
        kind: task.kind,
        complexity: task.complexity,
        request,
        context,
        sourceSequences: [...task.sourceSequences],
      },
    ];
  });
}

export class DiscordVoiceTaskQueue {
  constructor({
    runTask,
    postText,
    createTaskThread,
    logger = console,
    concurrency = 2,
    maximumPendingTasks = 10,
    taskTimeoutMs = 3_600_000,
    checkpoint = async () => undefined,
    onResult = async () => undefined,
    applyTask,
    progressIntervalMs = 10_000,
    checkpointTimeoutMs = DEFAULT_STAGE_TIMEOUTS.posting,
  }) {
    this.checkpoint = checkpoint;
    this.stateWriting = Promise.resolve();
    this.onResult = onResult;
    this.applyTaskChanges = applyTask;
    this.progressIntervalMs = progressIntervalMs;
    this.checkpointTimeoutMs = checkpointTimeoutMs;
    this.tasks = new Map();
    this.runTask = runTask;
    this.postText = postText;
    this.createTaskThread = createTaskThread;
    this.logger = logger;
    this.concurrency = concurrency;
    this.maximumPendingTasks = maximumPendingTasks;
    this.taskTimeoutMs = taskTimeoutMs;
    this.queue = [];
    this.running = new Set();
    this.tasksByThreadId = new Map();
    this.active = 0;
    this.closed = false;
    this.stopping = undefined;
    this.shutdownController = new AbortController();
  }

  enqueue(task) {
    return Boolean(this.#enqueueTask(task));
  }

  async enqueueDurable(task) {
    const accepted = this.#enqueueTask(task);
    if (!accepted) return false;
    if (accepted.state === "cancelled") {
      await this.persist({ strict: true });
      return true;
    }
    await accepted.acceptancePromise;
    return true;
  }

  #enqueueTask(task) {
    if (this.closed) return false;
    let previous;
    if (task.requestKey) {
      previous = [...this.tasks.values()].find(
        (candidate) => candidate.requestKey === task.requestKey,
      );
      if (
        previous &&
        (!previous.receiptFailed ||
          previous.state === "cancelled" ||
          previous.executing)
      )
        return previous;
    }
    if (this.queue.length + this.active >= this.maximumPendingTasks)
      return false;
    let id = previous?.id ?? task.id;
    if (id && this.tasks.has(id) && this.tasks.get(id) !== previous)
      throw new Error("Task ID already belongs to another request");
    if (!id)
      do {
        id = randomUUID().slice(0, 8);
      } while (this.tasks.has(id));
    const queuedTask = {
      ...task,
      id,
      createdAt: Date.now(),
      instructions: [],
      cancelled: false,
      executing: false,
      state: "queued",
    };
    this.tasks.set(queuedTask.id, queuedTask);
    queuedTask.checkpoint = () => this.persist();
    queuedTask.acceptancePromise = this.persist({ strict: true }).catch(
      (error) => {
        queuedTask.receiptFailed = true;
        throw error;
      },
    );
    queuedTask.surfacePromise = queuedTask.acceptancePromise.then(() =>
      withTimeout(
        () => {
          if (this.closed || queuedTask.cancelled)
            throw new VoiceServiceError(
              "TASK_CANCELLED",
              "Task cancelled before surface creation",
              "開始前に中止しました。",
            );
          return this.createTaskThread(queuedTask);
        },
        DEFAULT_STAGE_TIMEOUTS.posting,
        "creating task thread",
        undefined,
      ),
    );
    void queuedTask.surfacePromise
      .then((surface) => {
        queuedTask.surface = surface;
        if (surface?.threadId)
          this.tasksByThreadId.set(String(surface.threadId), queuedTask);
        void this.persist();
      })
      .catch(() => undefined);
    this.queue.push(queuedTask);
    this.#drain();
    return queuedTask;
  }

  snapshot({ includeInstruction, receiptTask, receiptKey } = {}) {
    return [...this.tasks.values()].map((task) => ({
      id: task.id,
      title: task.title,
      request: task.request,
      requestKey: task.requestKey,
      receiptFailed: task.receiptFailed,
      context: task.context,
      kind: task.kind,
      complexity: task.complexity,
      createdAt: task.createdAt,
      meetingId: task.meetingId,
      state: task.state,
      instructions: structuredClone(
        task.instructions
          .filter((entry) => !entry?.pending || entry === includeInstruction)
          .map((entry) =>
            typeof entry === "string"
              ? entry
              : {
                  id: entry.id,
                  text: entry.text,
                  requestKey: entry.requestKey,
                },
          ),
      ),
      controlReceipts: structuredClone(
        Object.fromEntries(
          Object.entries(task.controlReceipts ?? {}).filter(
            ([key]) =>
              !task.pendingControlReceipts?.has(key) ||
              (task === receiptTask && key === receiptKey),
          ),
        ),
      ),
      cancelled: task.cancelled,
      codexThreadId: task.codexThreadId ?? task.codexThread?.id,
      workingDirectory: task.workingDirectory,
      baseCommit: task.baseCommit,
      baselineTree: task.baselineTree,
      baselineFingerprint: task.baselineFingerprint,
      applied: task.applied,
      appliedRevision: task.appliedRevision,
      appliedFileState: structuredClone(task.appliedFileState),
      threadId: task.surface?.threadId ?? task.threadId,
      starterId: task.surface?.starterId ?? task.starterId,
      result: task.result,
      artifacts: structuredClone(task.artifacts),
      profile: structuredClone(task.profile),
      evidence: structuredClone(task.evidence),
      additionalInstruction: task.additionalInstruction,
      resultDeliveryPending: task.resultDeliveryPending,
      resultDeliveries: structuredClone(task.resultDeliveries ?? []),
      runRevision: task.runRevision,
    }));
  }

  persist({ strict = false, onSaved, onFailure, ...snapshotOptions } = {}) {
    const operation = this.stateWriting.then(async () => {
      try {
        await withTimeout(
          () => this.checkpoint(this.snapshot(snapshotOptions)),
          this.checkpointTimeoutMs,
          "saving task state",
        );
        onSaved?.();
        return true;
      } catch (error) {
        onFailure?.();
        this.#log("task_checkpoint_failed", {});
        if (strict)
          throw new VoiceServiceError(
            "TASK_STATE_SAVE_FAILED",
            "Task receipt could not be saved",
            "依頼を保存できなかったため作業を開始していません。保存先を確認して再試行してください。",
            { cause: error },
          );
        return false;
      }
    });
    this.stateWriting = operation.catch(() => undefined);
    return operation;
  }

  async restore(records, restoreSurface) {
    for (const record of records ?? []) {
      if (!record?.id) continue;
      const task = {
        ...record,
        instructions: structuredClone(record.instructions ?? []),
        executing: false,
      };
      if (
        ["running", "queued", "interrupted"].includes(task.state) &&
        task.additionalInstruction
      ) {
        retainInterruptedInstruction(task, task.additionalInstruction);
      }
      if (["running", "queued"].includes(task.state))
        task.state = "interrupted";
      task.resultDeliveries ??= [];
      if (
        task.resultDeliveryPending &&
        !task.resultDeliveries.length &&
        task.result
      ) {
        task.resultDeliveries.push({
          result: task.result,
          artifacts: task.artifacts,
          evidence: task.evidence,
          state: task.state,
          elapsedMs: Date.now() - task.createdAt,
          pendingInstructions: task.instructions.length,
          nextStep: 0,
        });
      }
      task.cancelled = true;
      task.checkpoint = () => this.persist();
      this.tasks.set(task.id, task);
      try {
        task.surface = await restoreSurface(task);
        task.surfacePromise = Promise.resolve(task.surface);
        if (task.surface?.threadId)
          this.tasksByThreadId.set(String(task.surface.threadId), task);
        await task.surface?.update?.({ state: task.state });
      } catch {
        this.#log("task_surface_restore_failed", { taskId: task.id });
      }
    }
    await this.persist();
  }

  list() {
    return [...this.tasks.values()].map(({ id, title, state, surface }) => ({
      id,
      title,
      state,
      threadId: surface?.threadId,
    }));
  }

  getReceipt(requestKey) {
    if (!requestKey) return undefined;
    const task = [...this.tasks.values()].find(
      (entry) => entry.requestKey === requestKey,
    );
    return task ? { id: task.id, state: task.state } : undefined;
  }

  handleTaskMessage({ taskId, ...message }) {
    const task = this.tasks.get(taskId);
    return this.#handleTaskInstruction(task, message);
  }

  async handleTaskMessageDurable({ taskId, ...message }) {
    const task = this.tasks.get(taskId);
    return this.#awaitControl(
      task,
      this.#handleTaskInstruction(task, message),
      message.requestKey,
    );
  }

  async handleThreadMessageDurable({ threadId, ...message }) {
    const task = this.tasksByThreadId.get(String(threadId));
    return this.#awaitControl(
      task,
      this.#handleTaskInstruction(task, message),
      message.requestKey,
    );
  }

  async #awaitControl(task, result, requestKey) {
    if (!result || result.type === "full") return result;
    if (
      result.type === "cancelled" &&
      result.persisted === false &&
      !task.controlPersistenceByKey?.has(requestKey)
    ) {
      delete result.persisted;
      void this.#persistControl(task, result, { requestKey }).catch(
        () => undefined,
      );
    }
    try {
      await (requestKey
        ? task.controlPersistenceByKey?.get(requestKey)
        : task.controlPersistence);
      if (result.type === "cancelled") await task.workerSettlement;
      return result;
    } catch (error) {
      if (result.type === "cancelled") return { ...result, persisted: false };
      throw error;
    }
  }

  #persistControl(
    task,
    result,
    { requestKey, entry, previousState, previousCancelled } = {},
  ) {
    task.controlReceipts ??= {};
    if (entry) entry.pending = true;
    if (requestKey) {
      task.controlReceipts[requestKey] = result;
      task.pendingControlReceipts ??= new Set();
      task.pendingControlReceipts.add(requestKey);
    }
    const saved = this.persist({
      strict: true,
      includeInstruction: entry,
      receiptTask: task,
      receiptKey: requestKey,
      onSaved: () => {
        if (entry) delete entry.pending;
        task.pendingControlReceipts?.delete(requestKey);
      },
      onFailure: () => {
        task.pendingControlReceipts?.delete(requestKey);
        if (entry) {
          task.instructions = task.instructions.filter(
            (candidate) => candidate !== entry,
          );
          if (requestKey) delete task.controlReceipts[requestKey];
          if (
            !task.executing &&
            !this.queue.includes(task) &&
            !task.instructions.length
          ) {
            task.state = previousState;
            task.cancelled = previousCancelled;
          }
        } else result.persisted = false;
        void this.persist();
      },
    });
    task.controlPersistence = saved;
    task.instructionBarrier = saved.catch(() => undefined);
    if (requestKey) {
      task.controlPersistenceByKey ??= new Map();
      task.controlPersistenceByKey.set(requestKey, saved);
      void saved
        .finally(() => task.controlPersistenceByKey.delete(requestKey))
        .catch(() => undefined);
    }
    return saved;
  }

  async #waitForInstructionReceipts(task) {
    let current;
    do {
      current = task.instructionBarrier;
      await current;
    } while (current !== task.instructionBarrier);
  }

  async applyTask(taskId, expectedRevision) {
    const task = this.tasks.get(taskId);
    if (
      !task ||
      task.state !== "completed" ||
      task.executing ||
      (expectedRevision !== undefined &&
        expectedRevision !== task.artifacts?.runRevision) ||
      (task.applied &&
        (!task.appliedRevision ||
          task.appliedRevision === task.artifacts?.runRevision)) ||
      !this.applyTaskChanges
    )
      return false;
    if (!(await this.applyTaskChanges(task))) return false;
    await this.persist();
    await Promise.resolve(task.surface?.update?.({ state: task.state })).catch(
      () => undefined,
    );
    return true;
  }

  async retryResultDelivery() {
    if (this.deliveringResults || this.closed) return;
    this.deliveringResults = true;
    try {
      for (const task of this.tasks.values()) {
        if (task.resultDeliveryPending) await this.#deliverTaskResults(task);
      }
    } finally {
      this.deliveringResults = false;
    }
  }

  #deliverTaskResults(task) {
    if (!task.deliveryPromise) {
      task.deliveryPromise = this.#flushTaskResults(task).finally(() => {
        task.deliveryPromise = undefined;
      });
    }
    return task.deliveryPromise;
  }

  async #flushTaskResults(task) {
    try {
      while (task.resultDeliveries?.length && !this.closed) {
        const delivery = task.resultDeliveries[0];
        const surface = task.surface;
        const post = typeof surface === "function" ? surface : surface?.post;
        if (!post) throw new Error("Task result surface is unavailable");
        const stages = [
          () =>
            post(
              "📦 **実行結果**\n" +
                formatVerificationEvidence(delivery.evidence),
            ),
          ...splitDiscordText(delivery.result).map(
            (chunk) => () => post(chunk),
          ),
        ];
        if (delivery.artifacts) {
          stages.push(() =>
            post(
              "🔬 **確認用の成果**\n" +
                "workspace: " +
                delivery.artifacts.workingDirectory +
                "\n" +
                "patch: " +
                delivery.artifacts.patchPath +
                "\n" +
                "変更状態:\n" +
                boundText(delivery.artifacts.status || "差分なし", 900) +
                "\n元の作業場所へは自動反映しません。",
            ),
          );
          // Production surfaces (including restored ones) attach the exact saved revision.
          stages.push(() =>
            surface?.postArtifacts?.(delivery.artifacts, delivery.evidence),
          );
        }
        stages.push(
          () =>
            post(
              delivery.pendingInstructions
                ? "⏭️ **追加指示へ続行** " +
                    task.id +
                    "\n残り: " +
                    delivery.pendingInstructions +
                    "件"
                : "✅ **Codexタスク完了** " +
                    task.id +
                    "\n" +
                    escapeDiscordMarkdown(task.title) +
                    "\n所要時間: " +
                    formatElapsedTime(delivery.elapsedMs),
            ),
          () =>
            surface?.update?.({
              state: task.state,
              elapsedMs: delivery.elapsedMs,
              pendingInstructions: task.instructions.length,
            }),
          () =>
            this.onResult({
              id: task.id,
              title: task.title,
              state: delivery.state,
              result: delivery.result,
              verification: formatVerificationEvidence(delivery.evidence),
              threadId: surface?.threadId ?? task.threadId,
              artifacts: delivery.artifacts,
              meetingId: task.meetingId,
            }),
        );
        for (
          let index = delivery.nextStep ?? 0;
          index < stages.length;
          index++
        ) {
          await withTimeout(
            stages[index],
            DEFAULT_STAGE_TIMEOUTS.posting,
            "delivering saved task result",
            this.shutdownController.signal,
          );
          delivery.nextStep = index + 1;
          await this.persist();
        }
        task.resultDeliveries.shift();
        task.resultDeliveryPending = Boolean(task.resultDeliveries.length);
        await this.persist();
      }
    } catch {
      task.resultDeliveryPending = true;
      await this.persist();
      this.#log("task_result_delivery_failed", { taskId: task.id });
    }
  }

  handleThreadMessage({ threadId, ...message }) {
    const task = this.tasksByThreadId.get(String(threadId));
    return this.#handleTaskInstruction(task, message);
  }

  #handleTaskInstruction(task, { userId, ownerUserId, content, requestKey }) {
    if (this.closed || userId !== ownerUserId) return false;
    const instruction = boundText(content, MAX_DISCORD_MESSAGE);
    if (!task || !instruction) return false;
    if (requestKey && Object.hasOwn(task.controlReceipts ?? {}, requestKey))
      return task.controlReceipts[requestKey];
    if (
      /^(?:停止|中止|キャンセル|stop|cancel)[!！。\s]*$/iu.test(instruction)
    ) {
      const discardedInstructions = task.instructions.length;
      task.cancelled = true;
      task.state = "cancelled";
      task.instructions.length = 0;
      task.cancelledInstructionCount = discardedInstructions;
      this.queue = this.queue.filter((queued) => queued !== task);
      task.controller?.abort(
        new VoiceServiceError(
          "TASK_CANCELLED",
          "Discord task cancelled by its owner.",
          "本人の操作によりタスクを中止しました。",
        ),
      );
      const result = { type: "cancelled", discardedInstructions };
      void this.#persistControl(task, result, { requestKey }).catch(
        () => undefined,
      );
      if (!task.executing) void this.#markCancelled(task.surface, task);
      return result;
    }
    if (
      !task.executing &&
      !this.queue.includes(task) &&
      this.queue.length + this.active >= this.maximumPendingTasks
    )
      return { type: "full" };
    const disposition =
      task.executing || this.queue.includes(task) ? "queued" : "resumed";
    if (task.instructions.length >= 10) return { type: "full" };
    const previousState = task.state;
    const previousCancelled = task.cancelled;
    const entry = { id: randomUUID(), text: instruction, requestKey };
    task.instructions.push(entry);
    task.state = task.executing ? "running" : "queued";
    task.cancelled = false;
    const result = {
      type: "instruction",
      disposition,
      pendingInstructions: task.instructions.length,
    };
    void this.#persistControl(task, result, {
      requestKey,
      entry,
      previousState,
      previousCancelled,
    })
      .then(() => {
        if (this.closed || task.cancelled || !task.instructions.includes(entry))
          return;
        if (
          task.executing &&
          (task.controller?.signal.aborted || task.workerFailed)
        )
          task.resumeAfterAbort = true;
        if (!task.executing && !this.queue.includes(task)) {
          if (!task.surface) task.surfacePromise = undefined;
          this.queue.push(task);
          this.#drain();
        } else {
          void Promise.resolve(
            task.surface?.update?.({
              state: task.executing ? "running" : "queued",
              pendingInstructions: task.instructions.length,
            }),
          ).catch(() => undefined);
        }
      })
      .catch(() => undefined);
    return result;
  }

  handleVoiceControl(control) {
    const task = this.#voiceControlTask(control);
    return this.#handleTaskInstruction(task, {
      userId: "voice-owner",
      ownerUserId: "voice-owner",
      requestKey: control.requestKey,
      content: control.type === "stop" ? "停止" : control.instruction,
    });
  }

  async handleVoiceControlDurable(control) {
    const task = this.#voiceControlTask(control);
    return this.#awaitControl(
      task,
      this.#handleTaskInstruction(task, {
        userId: "voice-owner",
        ownerUserId: "voice-owner",
        requestKey: control.requestKey,
        content: control.type === "stop" ? "停止" : control.instruction,
      }),
      control.requestKey,
    );
  }

  #voiceControlTask(control) {
    let candidates = [...this.tasks.values()];
    if (control?.requestKey) {
      const previous = candidates.find((task) =>
        Object.hasOwn(task.controlReceipts ?? {}, control.requestKey),
      );
      if (previous) return previous;
    }
    if (control?.taskId)
      candidates = candidates.filter((task) => task.id === control.taskId);
    else
      candidates = candidates.filter(
        (task) =>
          !task.cancelled && (task.executing || this.queue.includes(task)),
      );
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  stop() {
    if (this.stopping) return this.stopping;
    if (this.closed) return Promise.resolve();
    this.closed = true;
    const queued = this.queue.splice(0);
    this.shutdownController.abort(
      new VoiceServiceError(
        "SERVICE_STOPPED",
        "Discord voice task queue stopped.",
        "音声サービスを停止しました。",
      ),
    );
    const cancellations = queued.map((task) =>
      Promise.resolve(task.surfacePromise)
        .then((surface) =>
          task.cancelled
            ? this.#markCancelled(surface, task)
            : this.#markInterrupted(surface, task),
        )
        .catch(() => undefined),
    );
    this.stopping = Promise.allSettled([
      ...this.running,
      ...cancellations,
      ...[...this.tasks.values()].flatMap((task) => [
        task.controlPersistence,
        ...(task.controlPersistenceByKey?.values() ?? []),
      ]),
    ]).then(() => this.persist({ strict: true }));
    return this.stopping;
  }

  #drain() {
    while (
      !this.closed &&
      this.active < this.concurrency &&
      this.queue.length
    ) {
      const task = this.queue.shift();
      this.active += 1;
      const execution = this.#execute(task);
      this.running.add(execution);
      void execution.finally(() => {
        this.running.delete(execution);
        this.active -= 1;
        this.#drain();
      });
    }
  }

  async #execute(task) {
    task.executing = true;
    const startedAt = Date.now();
    const title = escapeDiscordMarkdown(task.title);
    let taskSurface;
    let postTaskText;
    let workerSucceeded = false;
    let workerInvoked = false;
    let consumedInstruction;
    let removeShutdownAbort = () => undefined;
    try {
      if (!task.surfacePromise) {
        task.surfacePromise = this.persist({ strict: true }).then(() =>
          withTimeout(
            () => {
              if (this.closed || task.cancelled)
                throw new VoiceServiceError(
                  "TASK_CANCELLED",
                  "Task cancelled before surface recovery",
                  "開始前に中止しました。",
                );
              return this.createTaskThread(task);
            },
            DEFAULT_STAGE_TIMEOUTS.posting,
            "recovering task thread",
            this.shutdownController.signal,
          ),
        );
      }
      taskSurface = await task.surfacePromise;
      task.surface = taskSurface;
      if (taskSurface?.threadId)
        this.tasksByThreadId.set(String(taskSurface.threadId), task);
      if (task.cancelled || this.closed) {
        if (task.cancelled) await this.#markCancelled(taskSurface, task);
        else await this.#markInterrupted(taskSurface, task);
        return;
      }
      task.executing = true;
      task.state = "running";
      task.controller = new AbortController();
      const abortTask = () =>
        task.controller?.abort(this.shutdownController.signal.reason);
      this.shutdownController.signal.addEventListener("abort", abortTask, {
        once: true,
      });
      removeShutdownAbort = () =>
        this.shutdownController.signal.removeEventListener("abort", abortTask);
      await this.persist();
      postTaskText =
        typeof taskSurface === "function" ? taskSurface : taskSurface.post;
      const updateTask =
        typeof taskSurface === "function"
          ? async () => undefined
          : (state) => taskSurface.update(state);
      await this.#waitForInstructionReceipts(task);
      consumedInstruction = task.instructions.shift();
      task.additionalInstruction =
        typeof consumedInstruction === "string"
          ? consumedInstruction
          : consumedInstruction?.text;
      await this.persist({ strict: true });
      const isContinuation = Boolean(task.additionalInstruction);
      await withTimeout(
        (signal) =>
          updateTask({
            state: "running",
            pendingInstructions: task.instructions.length,
            signal,
          }),
        DEFAULT_STAGE_TIMEOUTS.posting,
        "updating task status",
        this.shutdownController.signal,
      );
      await withTimeout(
        (signal) =>
          postTaskText(
            isContinuation
              ? `🔁 **追加指示の処理を開始** \`${task.id}\`\n残り: ${task.instructions.length}件`
              : `🧰 **Codexタスク開始** \`${task.id}\`\n${title}`,
            { signal },
          ),
        DEFAULT_STAGE_TIMEOUTS.posting,
        "posting task start",
        this.shutdownController.signal,
      );
      let progressPosts = 0;
      let lastProgress = "";
      let lastProgressAt = 0;
      const response = boundText(
        await withTimeout(
          (signal) => {
            const execution = Promise.resolve().then(() => {
              signal.throwIfAborted();
              workerInvoked = true;
              return this.runTask(task, {
                signal,
                onProgress: async (progress) => {
                  const content = boundText(progress, MAX_DISCORD_MESSAGE);
                  if (
                    !content ||
                    content === lastProgress ||
                    progressPosts >= 50 ||
                    Date.now() - lastProgressAt < this.progressIntervalMs
                  ) {
                    return;
                  }
                  lastProgress = content;
                  lastProgressAt = Date.now();
                  progressPosts += 1;
                  await withTimeout(
                    (postSignal) =>
                      postTaskText(content, { signal: postSignal }),
                    DEFAULT_STAGE_TIMEOUTS.posting,
                    "posting task progress",
                    this.shutdownController.signal,
                  ).catch((error) => {
                    this.#log("power_task_progress_post_failed", {
                      taskId: task.id,
                      errorCode: voiceErrorCode(error),
                    });
                  });
                },
              });
            });
            task.workerSettlement = execution.then(
              () => undefined,
              () => undefined,
            );
            return execution;
          },
          this.taskTimeoutMs,
          "running power task",
          task.controller.signal,
        ),
        MAX_CODEX_RESPONSE_CHARACTERS,
      );
      task.result = response;
      workerSucceeded = true;
      task.additionalInstruction = undefined;
      await this.#waitForInstructionReceipts(task);
      const pendingInstructions = task.instructions.length;
      task.state =
        pendingInstructions && !task.cancelled ? "queued" : "completed";
      task.resultDeliveries ??= [];
      task.resultDeliveries.push({
        result: response,
        artifacts: structuredClone(task.artifacts),
        evidence: structuredClone(task.evidence),
        state: task.state,
        pendingInstructions,
        elapsedMs: Date.now() - task.createdAt,
        nextStep: 0,
      });
      task.resultDeliveryPending = true;
      await this.persist();
      await this.#deliverTaskResults(task);
      this.#log(
        pendingInstructions
          ? "power_task_continuation_queued"
          : "power_task_completed",
        {
          taskId: task.id,
          elapsedMs: Date.now() - startedAt,
          responseCharacters: response.length,
          progressPosts,
          pendingInstructions,
        },
      );
      await this.#waitForInstructionReceipts(task);
      if (task.instructions.length && !task.cancelled) {
        task.state = "queued";
        this.queue.push(task);
      } else if (!task.cancelled) task.state = "completed";
      await this.persist();
    } catch (error) {
      task.workerFailed = !workerSucceeded;
      if (this.closed && !task.cancelled) {
        if (!workerSucceeded)
          retainInterruptedInstruction(
            task,
            consumedInstruction,
            workerInvoked,
          );
        if (workerSucceeded && !task.instructions.length) {
          task.state = "completed";
          await this.persist();
        } else await this.#markInterrupted(taskSurface, task);
        return;
      }
      if (
        !workerSucceeded &&
        consumedInstruction &&
        !task.cancelled &&
        !this.closed &&
        error?.code !== "TASK_CANCELLED"
      ) {
        retainInterruptedInstruction(task, consumedInstruction, workerInvoked);
      }
      if (this.closed || task.cancelled || error?.code === "TASK_CANCELLED") {
        await this.#markCancelled(taskSurface, task);
      } else if (workerSucceeded) {
        task.state = task.instructions.length ? "queued" : "completed";
        task.resultDeliveryPending = true;
        await this.persist();
        if (task.instructions.length) this.queue.push(task);
        this.#log("task_result_delivery_failed", { taskId: task.id });
      } else {
        task.state = "failed";
        await this.persist();
        this.#log("power_task_failed", {
          taskId: task.id,
          elapsedMs: Date.now() - startedAt,
          errorCode: voiceErrorCode(error),
        });
        await (postTaskText ?? this.postText)(
          `⚠️ **Codexタスク失敗** \`${task.id}\`\n${voiceErrorMessage(error)}`,
        ).catch(() => undefined);
        await Promise.resolve(
          taskSurface?.update?.({
            state: "failed",
            elapsedMs: Date.now() - task.createdAt,
          }),
        ).catch(() => undefined);
      }
    } finally {
      await task.workerSettlement;
      removeShutdownAbort();
      task.executing = false;
      task.controller = undefined;
      task.additionalInstruction = undefined;
      task.workerSettlement = undefined;
      task.workerFailed = false;
      if (task.resumeAfterAbort && !this.closed && task.instructions.length) {
        task.resumeAfterAbort = false;
        task.cancelled = false;
        task.state = "queued";
        this.queue.push(task);
        await this.persist();
      }
    }
  }

  async #markCancelled(surface, task) {
    task.state = "cancelled";
    await this.persist();
    if (!surface) return;
    const post = typeof surface === "function" ? surface : surface.post;
    await Promise.resolve(
      post?.(
        `⏹️ **Codexタスク中止** \`${task.id}\`${task.cancelledInstructionCount ? `\n未処理の追加指示 ${task.cancelledInstructionCount}件も破棄しました。` : ""}`,
      ),
    ).catch(() => undefined);
    await Promise.resolve(
      surface?.update?.({
        state: "cancelled",
        elapsedMs: Date.now() - task.createdAt,
      }),
    ).catch(() => undefined);
  }

  async #markInterrupted(surface, task) {
    task.state = "interrupted";
    await this.persist();
    await withTimeout(
      () =>
        surface?.update?.({
          state: "interrupted",
          pendingInstructions: task.instructions.length,
        }),
      DEFAULT_STAGE_TIMEOUTS.posting,
      "showing interrupted task",
    ).catch(() => undefined);
  }

  #log(event, detail) {
    try {
      this.logger.info?.({ component: "discord-voice", event, ...detail });
    } catch {
      // Task execution must not depend on logging.
    }
  }
}

export function formatElapsedTime(elapsedMs) {
  const numeric = Number(elapsedMs);
  const totalSeconds = Number.isFinite(numeric)
    ? Math.max(0, Math.round(numeric / 1_000))
    : 0;
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
}

export class DiscordVoiceMeetingSession {
  constructor({
    transcribe,
    observe,
    upsertLiveTranscript,
    upsertMinutes,
    archiveTranscript = async () => undefined,
    closeTranscriptArchive = async () => undefined,
    postText,
    synthesize,
    playAudio,
    enqueueTask = () => false,
    controlTask = () => false,
    getTaskReceipt = () => undefined,
    ownerUserId,
    tasksEnabled = false,
    operatorUserIds = [],
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
    this.dependencies = {
      transcribe,
      observe,
      upsertLiveTranscript,
      upsertMinutes,
      archiveTranscript,
      closeTranscriptArchive,
      postText,
      synthesize,
      playAudio,
      enqueueTask,
      controlTask,
      getTaskReceipt,
    };
    this.logger = logger;
    this.ownerUserId = ownerUserId;
    this.operatorUserIds = operatorUserIds;
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
    this.activeTranscriptionJobs = new Set();
    this.activeOperations = new Set();
    this.archiveOperations = new WeakMap();
    this.meetingId = initialState.meetingId ?? randomUUID();
    this.statements = initialState.statements ?? [];
    this.sequence = initialState.sequence ?? 0;
    this.minutes = initialState.minutes ?? "";
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
    this.speechTurns = new SpeechTurnAssembler(initialState.speechTurns ?? []);
    this.speechTurns.interrupt();
    this.statements.push(...this.speechTurns.drain());
    this.revision = initialState.revision ?? 0;
    this.resetting = false;
    this.meetingBoundary = Promise.resolve();
    this.activeTextInputs = 0;
    this.observing = false;
    this.immediateObservationRequested = false;
    this.immediateObservationScheduled = false;
    this.closed = false;
    this.droppedAudio = 0;
    this.failedTranscriptions = 0;
    this.archiveFailures = 0;
    this.shutdownController = new AbortController();
    this.liveUpdate = Promise.resolve();
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
      id: randomUUID(),
      sequence:
        turn?.sequence ?? (this.resetting ? undefined : (this.sequence += 1)),
      wav,
      metadata,
      queuedAt: Date.now(),
    });
    this.#drainTranscriptions();
    return true;
  }

  async persist() {
    await this.checkpoint({
      meetingId: this.meetingId,
      revision: this.revision,
      sequence: this.sequence,
      minutes: this.minutes,
      statements: this.statements,
      results: this.results,
      pendingTasks: structuredClone(this.pendingTasks),
      pendingControls: structuredClone(this.pendingControls),
      speechTurns: this.speechTurns.snapshot(),
    });
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
          state: task.cancelled ? "cancelled" : "awaiting_receipt",
        });
    }
    return [...tasks.values()];
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
      userId: metadata.userId,
      speakerName: metadata.speakerName,
      startedAt: metadata.startedAt ?? Date.now(),
    });
    return true;
  }

  async #flushSpeechTurns() {
    const completed = this.speechTurns.drain();
    this.statements.push(...completed);
    for (const statement of completed) await this.#archiveStatement(statement);
    await this.persist();
    this.#queueLiveUpdate();
    if (completed.length && this.immediateReactions) {
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
        id: randomUUID(),
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
      await this.#archiveStatement(statement);
      await this.persist();
      this.#queueLiveUpdate();
      if (this.immediateReactions || statement.requestReply) {
        this.immediateObservationRequested = true;
        this.#scheduleImmediateObservation();
      }
      return true;
    } finally {
      this.activeTextInputs--;
    }
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
      "議事録へ未反映の発言（訂正を含む）:",
      pending.length > recent.length
        ? `古い未反映発言 ${pending.length - recent.length} 件を省略。以下の最新発言を優先。`
        : "",
      formatMeetingObservationTranscript(recent),
      "直近の作業結果（詳細は各タスク）:",
      JSON.stringify(
        this.results
          .slice(-5)
          .map(({ id, title, state, result, threadId, verification }) => ({
            id,
            title: boundText(title, 120),
            state,
            result: boundText(result, 1000),
            threadId,
            verification,
          })),
      ),
    ].join("\n\n");
  }

  async addTaskResult(result) {
    while (this.resetting) await this.meetingBoundary;
    if (this.closed)
      throw new VoiceServiceError(
        "SERVICE_STOPPED",
        "Meeting is closed",
        "会議を停止しています。",
      );
    if (result.meetingId && result.meetingId !== this.meetingId) {
      await this.dependencies.postText(
        "📦 以前の会議のタスクが完了しました: " +
          result.title +
          (result.threadId ? " <#" + result.threadId + ">" : ""),
      );
      return;
    }
    this.results = this.results.filter((previous) => previous.id !== result.id);
    this.results.push({ ...result, result: boundText(result.result, 4000) });
    this.results = this.results.slice(-20);
    await this.persist();
    await this.dependencies.postText(
      "📦 **" +
        escapeDiscordMarkdown(result.title) +
        "** `" +
        result.id +
        "`\n" +
        (result.verification ? result.verification + "\n" : "") +
        boundText(result.result, 900) +
        "\n" +
        (result.threadId ? "詳細: <#" + result.threadId + ">" : ""),
    );
  }

  async newMeeting(resetObserver = async () => undefined) {
    if (
      this.closed ||
      this.resetting ||
      this.observing ||
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
      results: this.results,
      sequence: this.sequence,
      revision: this.revision,
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
      this.statements = [];
      this.results = [];
      this.sequence = 0;
      this.revision = 0;
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
    return this.#trackOperation(this.#observeNow());
  }

  async #observeNow() {
    if (this.closed || this.resetting || this.observing) return false;
    this.observing = true;
    const startedAt = Date.now();
    try {
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
      const raw = await withTimeout(
        (signal) =>
          this.dependencies.observe(
            {
              meetingId: this.meetingId,
              minutes: this.minutes,
              transcript,
              statements,
              activeTasks: this.getActiveTasks(),
              results: this.results,
            },
            { signal },
          ),
        this.stageTimeouts.running_codex,
        "observing meeting",
        this.shutdownController.signal,
      );
      const observation = parseMeetingObservation(raw, this.minutes);
      const authorizedStatements = statements.map((statement) => ({
        ...statement,
        userId:
          (statement.userId === this.ownerUserId ||
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
            observation.tasks,
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
            `📝 **議事録・共有コンテキスト（rev ${this.revision + 1}）**\n${boundText(observation.minutes, 1750)}\n全文: /ido context`,
            { signal },
          ),
        this.stageTimeouts.posting,
        "updating meeting minutes",
        this.shutdownController.signal,
      );
      this.minutes = observation.minutes;
      this.revision += 1;
      for (const task of tasks) {
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
        if (
          !this.pendingControls.some(
            (pending) => pending.requestKey === control.requestKey,
          )
        )
          this.pendingControls.push(control);
      }
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

      const reply = acceptedTasks.length
        ? `タスクを追加しました：${acceptedTasks.map((task) => task.title).join("、")}`
        : !observation.tasks.length &&
            !observation.taskControls.length &&
            observation.shouldReply
          ? observation.reply
          : "";
      if (reply) {
        for (const chunk of splitDiscordText(reply)) {
          await withTimeout(
            (signal) => this.dependencies.postText(chunk, { signal }),
            this.stageTimeouts.posting,
            "posting meeting response",
            this.shutdownController.signal,
          );
        }
        const spoken = speechExcerpt(reply);
        if (spoken) {
          const audio = await withTimeout(
            (signal) => this.dependencies.synthesize(spoken, { signal }),
            this.stageTimeouts.synthesizing,
            "synthesizing meeting response",
            this.shutdownController.signal,
          );
          await withTimeout(
            (signal) => this.dependencies.playAudio(audio, { signal }),
            this.stageTimeouts.speaking,
            "speaking meeting response",
            this.shutdownController.signal,
          );
        }
      }
      this.#log("meeting_observation_completed", {
        elapsedMs: Date.now() - startedAt,
        statements: statements.length,
        replied: Boolean(reply),
        tasks: acceptedTasks.length,
      });
      if (
        this.statements.some(
          (statement) =>
            !statement.observed &&
            (this.immediateReactions || statement.requestReply),
        )
      )
        this.immediateObservationRequested = true;
      return true;
    } catch (error) {
      if (!this.closed) {
        this.#log("meeting_observation_failed", {
          elapsedMs: Date.now() - startedAt,
          errorCode: voiceErrorCode(error),
        });
      }
      return false;
    } finally {
      this.observing = false;
      this.#scheduleImmediateObservation();
    }
  }

  async #dispatchPendingControls() {
    if (this.pendingControls.length) await this.persist();
    for (const control of [...this.pendingControls]) {
      if (this.closed) break;
      try {
        if (!control.notification) {
          const result = await withTimeout(
            async () =>
              (control.type === "stop" &&
                (await this.cancelPendingTask(control.taskId))) ||
              this.dependencies.controlTask(control),
            this.stageTimeouts.posting,
            "saving task control",
            this.shutdownController.signal,
          );
          if (result?.persisted === false)
            throw new Error("Control state save pending");
          control.notification = !result
            ? "操作対象が見つかりません。タスクIDと作業一覧を確認して再度依頼してください。"
            : result.type === "full"
              ? "追加指示の枠が満杯のため、今回の指示は受け付けていません。空きができたら再度依頼してください。"
              : control.type === "stop"
                ? `タスク ${control.taskId} を停止しました。`
                : `タスク ${control.taskId} への追加指示を保存しました。`;
          await this.persist();
        }
        await withTimeout(
          (signal) =>
            this.dependencies.postText(control.notification, { signal }),
          this.stageTimeouts.posting,
          "posting saved control receipt",
          this.shutdownController.signal,
        );
        this.pendingControls = this.pendingControls.filter(
          (pending) => pending !== control,
        );
        await this.persist();
        const audio = await withTimeout(
          (signal) =>
            this.dependencies.synthesize(control.notification, { signal }),
          this.stageTimeouts.synthesizing,
          "speaking control receipt",
          this.shutdownController.signal,
        );
        await withTimeout(
          (signal) => this.dependencies.playAudio(audio, { signal }),
          this.stageTimeouts.speaking,
          "playing control receipt",
          this.shutdownController.signal,
        );
      } catch (error) {
        this.#log("meeting_control_dispatch_pending", {
          requestKey: control.requestKey,
          errorCode: voiceErrorCode(error),
        });
      }
    }
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
                `⚠️ 作業枠が満杯のため「${escapeDiscordMarkdown(task.title)}」を開始していません。空きができたら再度依頼してください。`,
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
                  `依頼「${escapeDiscordMarkdown(task.title)}」（${task.id}）は会議に保存済みです。作業の受付を再試行しています。/ido status で確認、/ido stop ${task.id} で取り消せます。`,
                  { signal },
                ),
              this.stageTimeouts.posting,
              "posting receipt retry status",
              this.shutdownController.signal,
            );
            task.retryNoticeSent = true;
            await this.persist();
          } catch {
            /* The pending request remains visible in /ido status. */
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
    this.audioQueue = [];
    this.shutdownController.abort(
      new VoiceServiceError(
        "SERVICE_STOPPED",
        "Discord voice meeting session stopped.",
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

  async #transcribeItem(item) {
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
      if (item.metadata.utteranceId && !segmentSettled) {
        this.speechTurns.settle(
          item.metadata.utteranceId,
          item.metadata.segmentIndex,
          undefined,
        );
        await this.#flushSpeechTurns().catch(() => undefined);
      }
      this.#queueLiveUpdate();
      if (accepted && this.immediateReactions) {
        this.immediateObservationRequested = true;
        this.liveUpdate.finally(() => this.#scheduleImmediateObservation());
      }
    }
  }

  #queueLiveUpdate() {
    const statements = this.statements.filter(
      (statement) => !statement.observed,
    );
    let content = formatMeetingTranscript(statements);
    const notices = [];
    if (this.speechTurns.turns.size)
      notices.push(
        `${this.speechTurns.turns.size}件の発話を認識中。話し終わってから依頼を処理します`,
      );
    if (this.droppedAudio) notices.push(`未処理音声 ${this.droppedAudio} 件`);
    if (this.failedTranscriptions)
      notices.push(`認識失敗 ${this.failedTranscriptions} 件`);
    if (this.archiveFailures)
      notices.push(`保存再試行待ち ${this.archiveFailures} 件`);
    if (notices.length) content += `\n_状態: ${notices.join(" / ")}_`;
    this.liveUpdate = this.liveUpdate
      .then(() =>
        withTimeout(
          (signal) =>
            this.dependencies.upsertLiveTranscript(content, { signal }),
          this.stageTimeouts.posting,
          "updating live transcript",
          this.shutdownController.signal,
        ),
      )
      .catch((error) => {
        if (!this.closed)
          this.#log("meeting_live_update_failed", {
            errorCode: voiceErrorCode(error),
          });
      });
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
      this.logger.info?.({ component: "discord-voice", event, ...detail });
    } catch {
      // Meeting capture must not depend on logging.
    }
  }
}
