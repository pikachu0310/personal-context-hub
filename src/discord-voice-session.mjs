import { randomUUID } from "node:crypto";
import {
  VoiceServiceError,
  voiceErrorCode,
  voiceErrorMessage,
} from "./discord-voice-errors.mjs";

const MAX_DISCORD_MESSAGE = 1_900;
const MAX_TRANSCRIPT_CHARACTERS = 8_000;
const MAX_CODEX_RESPONSE_CHARACTERS = 12_000;
const TRUNCATION_SUFFIX = " …（長さ上限で省略）";
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
    void this.#drain();
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
    if (this.closed) return;
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

const MAX_MEETING_MINUTES_CHARACTERS = 1_600;
const MAX_MEETING_TRANSCRIPT_CHARACTERS = 16_000;
const MAX_LIVE_TRANSCRIPT_CHARACTERS = 1_850;

function escapeDiscordMarkdown(value) {
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
  return `${header}\n${omitted ? `_古い発話 ${omitted} 件は議事録へ移動しました。_\n` : ""}${body}`;
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
  return boundText(transcript, MAX_MEETING_TRANSCRIPT_CHARACTERS);
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
  return {
    minutes,
    shouldReply: parsed?.shouldReply === true && Boolean(reply),
    reply,
    tasks,
  };
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
      sources.some((statement) => statement.userId !== ownerUserId)
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
    logger = console,
    concurrency = 2,
    maximumPendingTasks = 10,
    taskTimeoutMs = 3_600_000,
  }) {
    this.runTask = runTask;
    this.postText = postText;
    this.logger = logger;
    this.concurrency = concurrency;
    this.maximumPendingTasks = maximumPendingTasks;
    this.taskTimeoutMs = taskTimeoutMs;
    this.queue = [];
    this.active = 0;
    this.closed = false;
    this.shutdownController = new AbortController();
  }

  enqueue(task) {
    if (this.closed) return false;
    if (this.queue.length + this.active >= this.maximumPendingTasks)
      return false;
    this.queue.push({ ...task, id: randomUUID().slice(0, 8) });
    this.#drain();
    return true;
  }

  stop() {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.shutdownController.abort(
      new VoiceServiceError(
        "SERVICE_STOPPED",
        "Discord voice task queue stopped.",
        "音声サービスを停止しました。",
      ),
    );
  }

  #drain() {
    while (
      !this.closed &&
      this.active < this.concurrency &&
      this.queue.length
    ) {
      const task = this.queue.shift();
      this.active += 1;
      void this.#execute(task).finally(() => {
        this.active -= 1;
        this.#drain();
      });
    }
  }

  async #execute(task) {
    const startedAt = Date.now();
    const title = escapeDiscordMarkdown(task.title);
    try {
      await withTimeout(
        (signal) =>
          this.postText(`🧰 **Codexタスク開始** \`${task.id}\`\n${title}`, {
            signal,
          }),
        DEFAULT_STAGE_TIMEOUTS.posting,
        "posting task start",
        this.shutdownController.signal,
      );
      const response = boundText(
        await withTimeout(
          (signal) => this.runTask(task, { signal }),
          this.taskTimeoutMs,
          "running power task",
          this.shutdownController.signal,
        ),
        MAX_CODEX_RESPONSE_CHARACTERS,
      );
      const chunks = splitDiscordText(
        response || "タスクは完了しましたが、結果メッセージは空でした。",
      );
      await withTimeout(
        (signal) =>
          this.postText(`✅ **Codexタスク完了** \`${task.id}\`\n${title}`, {
            signal,
          }),
        DEFAULT_STAGE_TIMEOUTS.posting,
        "posting task completion",
        this.shutdownController.signal,
      );
      for (const chunk of chunks) {
        await withTimeout(
          (signal) => this.postText(chunk, { signal }),
          DEFAULT_STAGE_TIMEOUTS.posting,
          "posting task result",
          this.shutdownController.signal,
        );
      }
      this.#log("power_task_completed", {
        taskId: task.id,
        elapsedMs: Date.now() - startedAt,
        responseCharacters: response.length,
      });
    } catch (error) {
      if (!this.closed) {
        this.#log("power_task_failed", {
          taskId: task.id,
          elapsedMs: Date.now() - startedAt,
          errorCode: voiceErrorCode(error),
        });
        await this.postText(
          `⚠️ **Codexタスク失敗** \`${task.id}\`\n${voiceErrorMessage(error)}`,
        ).catch(() => undefined);
      }
    }
  }

  #log(event, detail) {
    try {
      this.logger.info?.({ component: "discord-voice", event, ...detail });
    } catch {
      // Task execution must not depend on logging.
    }
  }
}

export class DiscordVoiceMeetingSession {
  constructor({
    transcribe,
    observe,
    upsertLiveTranscript,
    upsertMinutes,
    postText,
    synthesize,
    playAudio,
    enqueueTask = () => false,
    ownerUserId,
    tasksEnabled = false,
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
      postText,
      synthesize,
      playAudio,
      enqueueTask,
    };
    this.logger = logger;
    this.ownerUserId = ownerUserId;
    this.tasksEnabled = tasksEnabled;
    this.stageTimeouts = { ...DEFAULT_STAGE_TIMEOUTS, ...stageTimeouts };
    this.transcriptionConcurrency = transcriptionConcurrency;
    this.maximumPendingTranscriptions = maximumPendingTranscriptions;
    this.immediateReactions = immediateReactions;
    this.cancelInterval = cancelInterval;
    this.audioQueue = [];
    this.activeTranscriptions = 0;
    this.statements = [];
    this.sequence = 0;
    this.minutes = "";
    this.observing = false;
    this.immediateObservationRequested = false;
    this.immediateObservationScheduled = false;
    this.closed = false;
    this.droppedAudio = 0;
    this.failedTranscriptions = 0;
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
    const pending = this.audioQueue.length + this.activeTranscriptions;
    if (pending >= this.maximumPendingTranscriptions) {
      this.droppedAudio += 1;
      this.#log("meeting_audio_dropped", { pending });
      this.#queueLiveUpdate();
      return true;
    }
    this.audioQueue.push({
      id: randomUUID(),
      sequence: (this.sequence += 1),
      wav,
      metadata,
      queuedAt: Date.now(),
    });
    this.#drainTranscriptions();
    return true;
  }

  async observeNow() {
    if (this.closed || this.observing) return false;
    const statements = this.statements.filter(
      (statement) => !statement.observed,
    );
    if (!statements.length) return false;
    this.observing = true;
    const startedAt = Date.now();
    try {
      const transcript = formatMeetingObservationTranscript(statements);
      const raw = await withTimeout(
        (signal) =>
          this.dependencies.observe(
            { minutes: this.minutes, transcript, statements },
            { signal },
          ),
        this.stageTimeouts.running_codex,
        "observing meeting",
        this.shutdownController.signal,
      );
      const observation = parseMeetingObservation(raw, this.minutes);
      const tasks = this.tasksEnabled
        ? authorizeMeetingTasks(observation.tasks, statements, this.ownerUserId)
        : [];
      await withTimeout(
        (signal) =>
          this.dependencies.upsertMinutes(
            `📝 **議事録（自動更新）**\n${observation.minutes}`,
            { signal },
          ),
        this.stageTimeouts.posting,
        "updating meeting minutes",
        this.shutdownController.signal,
      );
      this.minutes = observation.minutes;
      for (const statement of statements) statement.observed = true;
      this.statements = this.statements.filter(
        (statement) => !statement.observed,
      );
      this.droppedAudio = 0;
      this.failedTranscriptions = 0;
      this.#queueLiveUpdate();

      let rejectedTasks = 0;
      for (const task of tasks) {
        if (!this.dependencies.enqueueTask(task)) rejectedTasks += 1;
      }
      if (rejectedTasks) {
        await withTimeout(
          (signal) =>
            this.dependencies.postText(
              `⚠️ Codexタスクqueueが満杯のため、${rejectedTasks}件を開始できませんでした。`,
              { signal },
            ),
          this.stageTimeouts.posting,
          "posting task queue status",
          this.shutdownController.signal,
        );
      }

      if (observation.shouldReply) {
        for (const chunk of splitDiscordText(observation.reply)) {
          await withTimeout(
            (signal) => this.dependencies.postText(chunk, { signal }),
            this.stageTimeouts.posting,
            "posting meeting response",
            this.shutdownController.signal,
          );
        }
        const spoken = speechExcerpt(observation.reply);
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
        replied: observation.shouldReply,
        tasks: tasks.length - rejectedTasks,
      });
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

  stop() {
    if (this.closed) return;
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
  }

  #drainTranscriptions() {
    while (
      !this.closed &&
      this.activeTranscriptions < this.transcriptionConcurrency &&
      this.audioQueue.length
    ) {
      const item = this.audioQueue.shift();
      this.activeTranscriptions += 1;
      void this.#transcribeItem(item).finally(() => {
        this.activeTranscriptions -= 1;
        this.#drainTranscriptions();
      });
    }
  }

  async #transcribeItem(item) {
    const startedAt = Date.now();
    let accepted = false;
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
        this.#log("meeting_transcript_discarded", {
          sequence: item.sequence,
          elapsedMs: Date.now() - startedAt,
          reason: "empty_transcript",
        });
        return;
      }
      this.statements.push({
        sequence: item.sequence,
        userId: item.metadata.userId,
        speakerName: item.metadata.speakerName,
        startedAt: item.metadata.startedAt ?? item.queuedAt,
        text,
        observed: false,
      });
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
    if (this.droppedAudio) notices.push(`未処理音声 ${this.droppedAudio} 件`);
    if (this.failedTranscriptions)
      notices.push(`認識失敗 ${this.failedTranscriptions} 件`);
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
