import { Readable } from "node:stream";
import { DiscordLiveBridge } from "./discord-voice-live.mjs";
import {
  TaskPreviewManager,
  formatTaskPreview,
} from "./discord-voice-preview.mjs";
import { browserPreviewVerifier } from "./discord-voice-preview-browser.mjs";
import { createHash, randomUUID } from "node:crypto";
import { formatVerificationEvidence } from "./discord-voice-evidence.mjs";
import { VoiceServiceError } from "./discord-voice-errors.mjs";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  RESTJSONErrorCodes,
} from "discord.js";
import prism from "prism-media";
import { MeetingStateStore, meetingScope } from "./discord-voice-state.mjs";
import {
  createIdobataMessageHandler,
  createIdobataInteractionHandler,
  taskControls,
  hasTaskChanges,
  IDOBATA_HELP,
  IDOBATA_APPLICATION_COMMAND,
  createIdobataSlashHandler,
} from "./discord-voice-commands.mjs";
import { readDiscordTokenStore } from "./discord-config.mjs";
import {
  PcmTurnBuffer,
  PcmSegmentBuffer,
  ttsPcm24kMonoToDiscordRaw,
  wrapPcmAsWav,
} from "./discord-voice-audio.mjs";
import {
  describeDiscordVoiceConfig,
  loadDiscordVoiceConfig,
} from "./discord-voice-config.mjs";
import {
  CodexVoiceRunner,
  createOpenAIAudioAdapter,
} from "./discord-voice-openai.mjs";
import {
  DiscordVoiceMeetingSession,
  DiscordVoiceSession,
  DiscordVoiceTaskQueue,
  boundText,
  escapeDiscordMarkdown,
  formatElapsedTime,
} from "./discord-voice-session.mjs";
import {
  createDiscordTranscriptPublisher,
  createLocalTranscriptArchive,
  createMeetingTranscriptArchive,
} from "./discord-voice-transcript-archive.mjs";

const PCM_BYTES_PER_SECOND = 48_000 * 2 * 2;
const AUDIO_RETRY_MESSAGE =
  "⚠️ 音声データを処理できませんでした。もう一度話してください。";

function logAudioFailure(logger, event, error) {
  try {
    logger.error?.({
      component: "discord-voice",
      event,
      errorName: error?.name ?? "Error",
    });
  } catch {
    // Audio cleanup must not depend on a logger implementation.
  }
}

function logInfoQuietly(logger, entry) {
  try {
    logger.info?.(entry);
  } catch {
    // Logging must never change service readiness or cleanup semantics.
  }
}

async function destroyQuietly(resource) {
  try {
    await resource?.destroy?.();
  } catch {
    // Cleanup must preserve the original startup failure or shutdown signal.
  }
}

export function serializeAudioPlayback(play) {
  let pending = Promise.resolve();
  return (audio, options = {}) => {
    if (options.signal?.aborted) return Promise.reject(options.signal.reason);
    const next = pending.then(() => {
      if (options.signal?.aborted) throw options.signal.reason;
      return play(audio, options);
    });
    pending = next.catch(() => undefined);
    return next;
  };
}

export function createDiscordPlayer(connection, logger = console) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  player.on("error", (error) => {
    logAudioFailure(logger, "playback_failed", error);
  });
  connection.subscribe(player);
  return serializeAudioPlayback(async (ttsPcm, { signal } = {}) => {
    if (signal?.aborted) throw signal.reason;
    const stopOnAbort = () => player.stop(true);
    signal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
      const raw = ttsPcm24kMonoToDiscordRaw(ttsPcm);
      const seconds = raw.length / PCM_BYTES_PER_SECOND;
      const resource = createAudioResource(Readable.from(raw), {
        inputType: StreamType.Raw,
      });
      player.play(resource);
      await entersState(player, AudioPlayerStatus.Playing, 5_000);
      await entersState(
        player,
        AudioPlayerStatus.Idle,
        Math.max(10_000, Math.ceil(seconds * 1_000) + 10_000),
      );
    } finally {
      signal?.removeEventListener("abort", stopOnAbort);
    }
  });
}

export function createDiscordLiveOutput(connection, logger = console) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Play },
  });
  player.on("error", (error) =>
    logAudioFailure(logger, "live_playback_failed", error),
  );
  connection.subscribe(player);
  let queued = Buffer.alloc(0);
  let stream;
  let closed = false;
  const clear = () => {
    queued = Buffer.alloc(0);
    stream?.destroy();
    stream = new Readable({ read() {}, highWaterMark: 3840 });
    player.play(createAudioResource(stream, { inputType: StreamType.Raw }));
  };
  clear();
  const timer = setInterval(() => {
    if (closed || stream.readableLength > 3840) return;
    const frame = Buffer.alloc(960);
    queued.copy(frame, 0, 0, Math.min(960, queued.length));
    queued = queued.subarray(Math.min(960, queued.length));
    stream.push(ttsPcm24kMonoToDiscordRaw(frame));
  }, 20);
  timer.unref();
  return {
    append(pcm) {
      if (closed) return;
      if (queued.length + pcm.length > 24000 * 2 * 5) {
        clear();
        logInfoQuietly(logger, {
          component: "discord-voice",
          event: "live_output_overflow",
        });
        return;
      }
      queued = Buffer.concat([queued, pcm]);
    },
    clear,
    close() {
      closed = true;
      clearInterval(timer);
      queued = Buffer.alloc(0);
      stream.destroy();
      player.stop(true);
    },
  };
}

export function subscribeToAllowedSpeaker({
  connection,
  config,
  session,
  postText,
  logger,
  resolveSpeakerName = (userId) => userId,
  createDecoder = (options) => new prism.opus.Decoder(options),
  live,
}) {
  const active = new Set();
  const notify = (content) =>
    Promise.resolve()
      .then(() => postText(content))
      .catch(() => undefined);
  connection.receiver.speaking.on("end", (userId) => live?.speakerEnd(userId));
  connection.receiver.speaking.on("start", (userId) => {
    if (!config.listenToEveryone && userId !== config.allowedUserId) return;
    live?.speakerStart(userId);
    if (active.has(userId)) return;
    const startedAt = Date.now();
    active.add(userId);
    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: config.silenceMs,
      },
    });
    const decoder = createDecoder({
      rate: 48_000,
      channels: 2,
      frameSize: 960,
    });
    const segmented =
      config.voiceMode === "meeting" &&
      typeof session.finishUtterance === "function";
    const turnBuffer = segmented
      ? new PcmSegmentBuffer(config)
      : new PcmTurnBuffer(config);
    const utteranceId = randomUUID();
    if (segmented)
      session.beginUtterance?.(utteranceId, {
        userId,
        speakerName: resolveSpeakerName(userId),
        startedAt,
      });
    let segmentIndex = 0;
    let segmentedBytes = 0;
    let utteranceFinished = false;
    const enqueueSegment = (pcm) => {
      const accepted = session.enqueue(wrapPcmAsWav(pcm), {
        userId,
        speakerName: resolveSpeakerName(userId),
        startedAt: startedAt + Math.floor(segmentedBytes / 192),
        utteranceId,
        segmentIndex: segmentIndex++,
      });
      segmentedBytes += pcm.length;
      return accepted;
    };
    const finishUtterance = (incomplete = false) => {
      if (!segmented || utteranceFinished) return;
      utteranceFinished = true;
      void session
        .finishUtterance(utteranceId, segmentIndex, { incomplete })
        .catch((error) =>
          logAudioFailure(logger, "utterance_finalize_failed", error),
        );
    };
    let discardedTurn = false;
    let finalized = false;

    decoder.on("data", (chunk) => {
      if (discardedTurn) return;
      try {
        live?.input(userId, chunk);
        if (segmented) {
          for (const pcm of turnBuffer.push(chunk)) enqueueSegment(pcm);
          return;
        }
        if (turnBuffer.push(chunk)) return;
        discardedTurn = true;
        active.delete(userId);
        opusStream.destroy();
        decoder.destroy();
        void notify(
          `⚠️ 発話が${config.maximumAudioSeconds}秒を超えたため破棄しました。`,
        );
      } catch (error) {
        discardedTurn = true;
        finishUtterance(true);
        active.delete(userId);
        opusStream.destroy();
        decoder.destroy();
        logAudioFailure(logger, "receive_frame_failed", error);
        void notify(AUDIO_RETRY_MESSAGE);
      }
    });
    const release = () => {
      active.delete(userId);
      live?.speakerEnd(userId);
    };
    opusStream.once("error", (error) => {
      discardedTurn = true;
      finalized = true;
      finishUtterance(true);
      release();
      decoder.destroy();
      logAudioFailure(logger, "receive_failed", error);
      void notify(AUDIO_RETRY_MESSAGE);
    });
    opusStream.once("close", release);
    decoder.once("close", () => {
      release();
      if (!finalized) finishUtterance(true);
    });
    decoder.once("error", (error) => {
      discardedTurn = true;
      finalized = true;
      finishUtterance(true);
      release();
      opusStream.destroy();
      logAudioFailure(logger, "decode_failed", error);
      void notify(AUDIO_RETRY_MESSAGE);
    });
    decoder.once("end", () => {
      if (finalized) return;
      finalized = true;
      release();
      if (discardedTurn) return;
      try {
        if (segmented) {
          const remaining = turnBuffer.finish();
          if (remaining) enqueueSegment(remaining);
          finishUtterance();
          return;
        }
        const completed = turnBuffer.finish();
        if (completed.status !== "accepted") return;
        if (
          !session.enqueue(wrapPcmAsWav(completed.pcm), {
            userId,
            speakerName: resolveSpeakerName(userId),
            startedAt,
          })
        ) {
          void notify(
            "⚠️ 音声ターンが混雑しています。少し待ってからもう一度話してください。",
          );
        }
      } catch (error) {
        finishUtterance(true);
        logAudioFailure(logger, "receive_finalize_failed", error);
        void notify(AUDIO_RETRY_MESSAGE);
      }
    });
    opusStream.pipe(decoder);
  });
}

export function createDiscordMessagePayload(
  content,
  { silent = true, idempotencyKey } = {},
) {
  return {
    content,
    allowedMentions: { parse: [] },
    ...(silent ? { flags: MessageFlags.SuppressNotifications } : {}),
    ...(idempotencyKey
      ? {
          nonce: createHash("sha256")
            .update(String(idempotencyKey))
            .digest("hex")
            .slice(0, 24),
          enforceNonce: true,
        }
      : {}),
  };
}

export function createEditableDiscordPost(textChannel, { silent = true } = {}) {
  let message;
  return async (content) => {
    const payload = createDiscordMessagePayload(content, { silent });
    if (!message || typeof message.edit !== "function") {
      message = await textChannel.send(payload);
      return message;
    }
    try {
      message = await message.edit({
        content,
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      if (error?.code !== RESTJSONErrorCodes.UnknownMessage) throw error;
      message = await textChannel.send(payload);
    }
    return message;
  };
}

export function createMinutesDiscordPost(textChannel, options = {}) {
  let message;
  let restored = false;
  let pinAttempted = false;
  const pin = async () => {
    if (pinAttempted || message?.pinned) return;
    pinAttempted = true;
    await message?.pin?.().catch(() => undefined);
  };
  return async (content, { minutes = "" } = {}) => {
    if (!restored) {
      restored = true;
      if (options.botUserId && textChannel.messages?.fetch) {
        const recent = await textChannel.messages
          .fetch({ limit: 50 })
          .catch(() => undefined);
        message = recent?.find(
          (item) =>
            item.author?.id === options.botUserId &&
            item.content?.startsWith("📝 **議事録"),
        );
      }
    }
    const payload = {
      ...createDiscordMessagePayload(content, options),
      files: [
        {
          attachment: Buffer.from(minutes || content, "utf8"),
          name: "minutes.md",
        },
      ],
      attachments: [],
    };
    if (message) {
      try {
        message = await message.edit(payload);
        await pin();
        return message;
      } catch (error) {
        if (error?.code !== RESTJSONErrorCodes.UnknownMessage) throw error;
      }
    }
    message = await textChannel.send(payload);
    // Pin only our minutes message; if permission is absent, /ido context and
    // the full attachment still make the current minutes available.
    pinAttempted = false;
    await pin();
    return message;
  };
}

const DISCORD_TASK_STATES = Object.freeze({
  queued: ["⏳", "待機中"],
  running: ["🟡", "実行中"],
  completed: ["✅", "完了"],
  failed: ["⚠️", "失敗"],
  cancelled: ["⏹️", "中止"],
  interrupted: ["⏸️", "再起動で中断・追加指示で再開"],
});

export function formatDiscordTaskCard(
  task,
  { state = "queued", threadId, elapsedMs, pendingInstructions = 0 } = {},
) {
  const [icon, defaultLabel] = DISCORD_TASK_STATES[state] ?? ["🧰", state];
  const label =
    state === "completed" && task.preview
      ? task.preview.state === "available"
        ? task.preview.confirmations?.length >= 4
          ? "4人が試用済み"
          : task.preview.browserVerified
            ? "試用版あり"
            : "起動済み・操作未確認"
        : "実装処理終了・試用状態を確認"
      : defaultLabel;
  const id = String(task.id ?? "unknown").replace(/[^a-zA-Z0-9_-]/g, "");
  const title = escapeDiscordMarkdown(
    boundText(String(task.title ?? "").replace(/[\r\n]+/g, " "), 120) ||
      "Codexタスク",
  );
  return [
    `${icon} **Codexタスク** \`${id || "unknown"}\``,
    `**${title}**`,
    `状態: **${label}**${Number.isFinite(elapsedMs) ? ` · ${formatElapsedTime(elapsedMs)}` : ""}${pendingInstructions > 0 ? ` · 追加指示 **${pendingInstructions}件待機**` : ""}`,
    task.profile
      ? `担当: ${task.profile.kind} · ${task.profile.model ?? "default"} / ${task.profile.modelReasoningEffort}`
      : `担当: ${task.kind ?? "implementation"}`,
    threadId ? `ログ: <#${threadId}>` : "ログスレッドを準備しています…",
    task.artifacts?.runRevision
      ? `実行版: **${task.artifacts.runRevision}**${task.appliedRevision === task.artifacts.runRevision ? " · 反映済み" : ""}`
      : "",
    state === "completed" && hasTaskChanges(task.artifacts) === false
      ? "差分: なし（検証記録を確認できます）"
      : "",
    state === "completed" ? formatVerificationEvidence(task.evidence) : "",
    task.preview ? formatTaskPreview(task.preview) : "",
  ].join("\n");
}

export function createDiscordArtifactPoster(
  thread,
  task,
  { silent = true } = {},
) {
  return async (artifacts, evidence, { idempotencyKey, signal } = {}) => {
    signal?.throwIfAborted();
    const patch = await readFile(artifacts.patchPath);
    if (
      patch.length > 1_000_000 ||
      /(?:BEGIN (?:RSA |OPENSSH )?PRIVATE KEY|sk-[A-Za-z0-9_-]{24,})/.test(
        patch.toString(),
      )
    ) {
      await thread.send(
        createDiscordMessagePayload(
          "差分はローカルworkspaceに保存しました。サイズまたは秘密値の検査により自動添付を省略しました。",
          { silent, idempotencyKey },
        ),
      );
      return;
    }
    await thread.send({
      ...createDiscordMessagePayload(
        patch.length
          ? `📎 実行版 ${artifacts.runRevision ?? 1} の差分と検証記録。前回反映した時点（未反映なら開始時点）からの変更です。確認後 \`/ido apply ${task.id} ${artifacts.runRevision ?? 1}\` で反映できます。`
          : `📎 実行版 ${artifacts.runRevision ?? 1} の検証記録。変更差分はありません。`,
        { silent, idempotencyKey },
      ),
      files: [
        ...(patch.length
          ? [
              {
                attachment: patch,
                name: `${task.id}-r${artifacts.runRevision ?? 1}.patch`,
              },
            ]
          : []),
        {
          attachment: Buffer.from(JSON.stringify(evidence ?? {}, null, 2)),
          name: `${task.id}-r${artifacts.runRevision ?? 1}-verification.json`,
        },
      ],
    });
  };
}

export function createDiscordTaskCardUpdater(
  textChannel,
  task,
  threadId,
  starter,
  { silent = true } = {},
) {
  let updating = Promise.resolve();
  const update = (options = {}) => {
    const next = updating.then(async () => {
      const { state, elapsedMs, pendingInstructions, signal, isCurrent } =
        options;
      signal?.throwIfAborted();
      if (isCurrent && !isCurrent()) return starter;
      const payload = {
        content: formatDiscordTaskCard(task, {
          state,
          threadId,
          elapsedMs,
          pendingInstructions,
        }),
        allowedMentions: { parse: [] },
        components: taskControls(
          task.id,
          state,
          task.artifacts?.runRevision,
          Boolean(
            task.appliedRevision &&
            task.appliedRevision === task.artifacts?.runRevision,
          ),
          hasTaskChanges(task.artifacts),
          task.preview,
        ),
      };
      if (starter) {
        try {
          starter = await starter.edit(payload);
          return starter;
        } catch (error) {
          if (error?.code !== RESTJSONErrorCodes.UnknownMessage) throw error;
        }
      }
      signal?.throwIfAborted();
      if (isCurrent && !isCurrent()) return starter;
      starter = await textChannel.send({
        ...createDiscordMessagePayload(payload.content, {
          silent,
          idempotencyKey: `task-card:${task.id}:${task.createdAt}:${starter?.id ?? task.starterId ?? "restore"}`,
        }),
        components: payload.components,
      });
      await task.checkpoint?.();
      return starter;
    });
    updating = next.catch(() => undefined);
    return next;
  };
  return {
    update,
    get starterId() {
      return starter?.id ?? task.starterId;
    },
  };
}

export function createDiscordTaskThread(textChannel, { silent = true } = {}) {
  return async (task) => {
    const creationKey = `task-thread:${task.id}:${task.createdAt}:${task.threadId ?? "initial"}`;
    const title = String(task.title ?? "Codexタスク")
      .replace(/[\r\n]+/g, " ")
      .trim();
    const starter = await textChannel.send(
      createDiscordMessagePayload(formatDiscordTaskCard(task), {
        silent,
        idempotencyKey: `${creationKey}:card`,
      }),
    );
    if (typeof starter.startThread !== "function") {
      throw new Error("Configured text channel cannot create task threads.");
    }
    let thread;
    try {
      thread = await starter.startThread({
        name: `${task.id} ${title}`.slice(0, 100),
        autoArchiveDuration: 1_440,
        reason: "Keep Codex task output separate from meeting minutes",
      });
    } catch (error) {
      // A message and the thread started from it share an ID. The creation
      // may have succeeded even when its HTTP acknowledgement was lost.
      const existing = await textChannel.client?.channels
        ?.fetch(starter.id, { force: true })
        .catch(() => undefined);
      if (
        existing?.isThread?.() &&
        String(existing.id) === String(starter.id) &&
        String(existing.parentId) === String(textChannel.id)
      ) {
        thread = existing;
      } else {
        await starter
          .edit({
            content: formatDiscordTaskCard(task, { state: "failed" }),
            allowedMentions: { parse: [] },
          })
          .catch(() => undefined);
        throw error;
      }
    }
    const threadId = String(thread.id ?? "");
    if (!threadId) throw new Error("Created task thread has no channel ID.");
    const card = createDiscordTaskCardUpdater(
      textChannel,
      task,
      threadId,
      starter,
      { silent },
    );
    const update = card.update;
    const post = (content, { signal, idempotencyKey } = {}) => {
      if (signal?.aborted) return Promise.reject(signal.reason);
      return thread.send(
        createDiscordMessagePayload(content, { silent, idempotencyKey }),
      );
    };
    try {
      await update({ state: "queued" });
      const request = escapeDiscordMarkdown(
        boundText(task.request, 1_200) || "依頼内容を取得できませんでした。",
      );
      await post(`🧾 **依頼内容**\n${request}`, {
        idempotencyKey: `${creationKey}:request`,
      });
      await post(
        [
          "💡 **このスレッドで操作できます**",
          "追加指示: そのままメッセージを送信",
          "停止: `停止` / `中止` / `キャンセル` / `stop` / `cancel`",
          "実行中の追加指示は、現在の処理が終わり次第、同じCodexセッションで続けます。",
        ].join("\n"),
        { idempotencyKey: `${creationKey}:help` },
      ).catch(() => undefined);
    } catch (error) {
      await update({ state: "failed" }).catch(() => undefined);
      throw error;
    }
    const postArtifacts = createDiscordArtifactPoster(thread, task, { silent });
    return {
      post,
      update,
      postArtifacts,
      threadId,
      get starterId() {
        return card.starterId;
      },
    };
  };
}

export function formatDiscordTaskAction(action) {
  if (action?.persisted === false)
    return "停止しましたが、停止状態を保存できませんでした。再起動後は作業一覧を確認してください。";
  if (action?.type === "save_failed")
    return "追加指示を保存できなかったため受け付けていません。保存先を確認して再試行してください。";
  if (action?.type === "full")
    return "追加指示の枠がいっぱいです。少し待ってから再送してください。";
  if (action?.type === "cancelled") {
    return action.discardedInstructions
      ? `⏹️ タスクを停止し、未処理の追加指示${action.discardedInstructions}件も破棄しました。`
      : "⏹️ タスクを停止しました。";
  }
  if (action?.type === "instruction") {
    return action.disposition === "resumed"
      ? "▶️ 追加指示を受け付けました。同じCodexセッションで再開します。"
      : `➕ 追加指示を受け付けました。現在の処理後に続けます（待機 ${action.pendingInstructions}件）。`;
  }
  return "";
}

export async function startDiscordVoiceCodex({
  config = loadDiscordVoiceConfig(),
  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      ...(config.messageContentIntent === false
        ? []
        : [GatewayIntentBits.MessageContent]),
    ],
  }),
  logger = console,
  dependencies = {},
} = {}) {
  const store =
    dependencies.meetingStateStore ??
    (config.meetingStatePath
      ? new MeetingStateStore(config.meetingStatePath, meetingScope(config))
      : undefined);
  let saved = await store?.load();
  // Build local adapters before Discord login so unsafe Codex configuration
  // fails closed without joining or sending to a channel.
  const audio = dependencies.audioAdapter ?? createOpenAIAudioAdapter(config);
  const codex = dependencies.codexRunner ?? new CodexVoiceRunner(config);
  await codex.prepare?.();
  const credential = await (
    dependencies.readCredential ?? readDiscordTokenStore
  )();
  let connection;
  let transcriptArchive;
  let session;
  let taskQueue;
  let live;
  let previews;
  let deliveryInterval;
  let loginAttempted = false;
  let serviceClosing = false;
  let reconnecting = false;
  let voiceRecoveryFailed = false;
  let manuallyDisconnected = false;
  let stopping;
  const pendingOperations = new Set();
  const trackOperation = (operation) => {
    pendingOperations.add(operation);
    void operation
      .finally(() => pendingOperations.delete(operation))
      .catch(() => undefined);
  };
  const stopService = () => {
    if (stopping) return stopping;
    serviceClosing = true;
    live?.close();
    clearInterval(deliveryInterval);
    stopping = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => previews?.close()),
        Promise.resolve().then(() => session?.stop?.()),
        Promise.resolve().then(() => taskQueue?.stop?.()),
        ...pendingOperations,
        ...(!session
          ? [Promise.resolve().then(() => transcriptArchive?.stop?.())]
          : []),
      ]);
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      try {
        await codex.close?.();
      } catch (error) {
        failures.push(error);
      }
      try {
        await store?.release();
      } catch (error) {
        failures.push(error);
      }
      await Promise.all([
        destroyQuietly(connection),
        loginAttempted ? destroyQuietly(client) : Promise.resolve(),
      ]);
      if (failures.length)
        throw new AggregateError(
          failures,
          "Voice service stopped with incomplete cleanup or state persistence.",
        );
    })();
    return stopping;
  };
  try {
    await store?.acquire();
    saved = await store?.load();
    client.on?.(Events.Error, (error) => {
      logAudioFailure(logger, "discord_client_failed", error);
    });
    const ready = client.isReady()
      ? Promise.resolve()
      : once(client, Events.ClientReady);
    loginAttempted = true;
    await client.login(credential.token);
    await ready;
    const guild = await client.guilds.fetch(config.guildId);
    const [voiceChannel, textChannel] = await Promise.all([
      guild.channels.fetch(config.voiceChannelId),
      guild.channels.fetch(config.textChannelId),
    ]);
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error("Configured voice channel is not a Guild Voice channel.");
    }
    if (!textChannel?.isTextBased() || typeof textChannel.send !== "function") {
      throw new Error("Configured text channel cannot receive Bot messages.");
    }
    const messageOptions = { silent: config.silentMessages !== false };
    const postText = (content, { idempotencyKey } = {}) =>
      textChannel.send(
        createDiscordMessagePayload(content, {
          ...messageOptions,
          idempotencyKey,
        }),
      );
    const createTaskThread = createDiscordTaskThread(
      textChannel,
      messageOptions,
    );
    const upsertLiveTranscript = createEditableDiscordPost(
      textChannel,
      messageOptions,
    );
    const upsertMinutes = createMinutesDiscordPost(textChannel, {
      ...messageOptions,
      botUserId: client.user?.id,
    });
    transcriptArchive =
      config.voiceMode === "meeting"
        ? (dependencies.transcriptArchive ??
          createMeetingTranscriptArchive({
            localArchive: createLocalTranscriptArchive({
              directory: config.transcriptArchiveDirectory,
              guildId: config.guildId,
              voiceChannelId: config.voiceChannelId,
              textChannelId: config.textChannelId,
            }),
            discordPublisher: config.transcriptArchiveDiscord
              ? createDiscordTranscriptPublisher({
                  textChannel,
                  createMessagePayload: (content) =>
                    createDiscordMessagePayload(content, messageOptions),
                  flushIntervalMs: config.transcriptArchiveFlushIntervalMs,
                  scheduleInterval: dependencies.scheduleInterval,
                  cancelInterval: dependencies.cancelInterval,
                  logger,
                })
              : undefined,
          }))
        : undefined;
    connection = (dependencies.joinVoiceChannel ?? joinVoiceChannel)({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    connection.on?.("error", (error) => {
      logAudioFailure(logger, "voice_connection_failed", error);
    });
    connection.on?.(VoiceConnectionStatus.Disconnected, () => {
      if (serviceClosing || reconnecting || manuallyDisconnected) return;
      reconnecting = true;
      voiceRecoveryFailed = false;
      const waitForState = dependencies.entersState ?? entersState;
      void (async () => {
        try {
          await Promise.race([
            waitForState(connection, VoiceConnectionStatus.Signalling, 5_000),
            waitForState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          await waitForState(connection, VoiceConnectionStatus.Ready, 20_000);
        } catch {
          if (serviceClosing || manuallyDisconnected) return;
          try {
            if (!connection.rejoin?.())
              throw new Error("Voice rejoin unavailable");
            await waitForState(connection, VoiceConnectionStatus.Ready, 20_000);
          } catch {
            if (serviceClosing || manuallyDisconnected) return;
            voiceRecoveryFailed = true;
            await postText(
              "⚠️ 通話との接続が切れ、再接続できませんでした。音声は受信していません。テキストで作業を続けられます。操作担当者は `/ido reconnect` で再接続を試せます。",
            ).catch(() => undefined);
          }
        } finally {
          reconnecting = false;
        }
      })();
    });
    await (dependencies.entersState ?? entersState)(
      connection,
      VoiceConnectionStatus.Ready,
      20_000,
    );
    let playAudio =
      dependencies.playAudio ?? createDiscordPlayer(connection, logger);
    previews = new TaskPreviewManager({
      command: config.previewCommand,
      workspaceRoot: config.taskWorkspaceDirectory,
      codexExecutable: config.codexExecutable,
      codexHome: config.isolatedCodexHome,
      sharedUrlTemplate: config.previewSharedUrlTemplate,
      verify:
        dependencies.verifyPreview ??
        browserPreviewVerifier(config.previewChecks, {
          executablePath: config.previewBrowserExecutable,
        }),
      onChange: async (task) => {
        await task.checkpoint?.();
        await task.surface?.update?.({
          state: task.state,
          pendingInstructions: task.instructions.length,
        });
      },
    });
    taskQueue = config.powerMode
      ? new DiscordVoiceTaskQueue({
          runTask: async (task, options) => {
            await previews.stop(task.id, "superseded");
            const result = await codex.runTask(task, options);
            try {
              await previews.start(task, options);
            } catch {
              task.preview = { state: "failed", runRevision: task.runRevision };
            }
            return result;
          },
          confirmPreview: (task, revision, userId) =>
            previews.confirm(task, revision, userId),
          invalidatePreview: (task, state = "superseded") =>
            previews.stop(task.id, state),
          steerTask: (task, instruction) =>
            codex.steerTask?.(task, instruction) ?? false,
          postText,
          createTaskThread,
          logger,
          concurrency: config.taskConcurrency,
          maximumPendingTasks: config.maximumPendingTasks,
          taskTimeoutMs: config.stageTimeouts.running_codex,
          checkpoint: async (tasks) => {
            await store?.save({ tasks });
            live?.taskState(tasks);
          },
          onResult: async (result, options) => {
            await session?.addTaskResult?.(result, options);
            if (result.meetingId === session?.meetingId)
              live?.taskResult(result);
          },
          applyTask: (task) => codex.applyTask(task),
        })
      : undefined;
    if (taskQueue && saved?.tasks?.length) {
      await taskQueue.restore(saved.tasks, async (task) => {
        const missingThread = () =>
          new VoiceServiceError(
            "TASK_SURFACE_MISSING",
            "Task result thread no longer exists",
            "結果スレッドが削除されています。",
          );
        if (!task.threadId) throw missingThread();
        const thread = await guild.channels
          .fetch(task.threadId)
          .catch((error) => {
            if (error?.code === RESTJSONErrorCodes.UnknownChannel)
              throw missingThread();
            throw error;
          });
        if (!thread) throw missingThread();
        const starter = task.starterId
          ? await textChannel.messages.fetch(task.starterId).catch((error) => {
              if (error?.code !== RESTJSONErrorCodes.UnknownMessage)
                throw error;
              return undefined;
            })
          : undefined;
        const card = createDiscordTaskCardUpdater(
          textChannel,
          task,
          task.threadId,
          starter,
          messageOptions,
        );
        return {
          threadId: task.threadId,
          get starterId() {
            return card.starterId;
          },
          postArtifacts: createDiscordArtifactPoster(
            thread,
            task,
            messageOptions,
          ),
          post: (content, { idempotencyKey } = {}) =>
            thread.send(
              createDiscordMessagePayload(content, {
                ...messageOptions,
                idempotencyKey,
              }),
            ),
          update: card.update,
        };
      });
    }
    session =
      config.voiceMode === "meeting"
        ? new DiscordVoiceMeetingSession({
            transcribe: audio.transcribe,
            quickReply: audio.quickReply,
            investigateQuestion: codex.investigateQuestion
              ? (question, options) =>
                  codex.investigateQuestion(question, options)
              : undefined,
            getRuntimeContext: () => ({
              voiceStatus: connection.state?.status,
              manuallyDisconnected,
              reconnecting,
              voiceRecoveryFailed,
              invocationId: /^[a-f0-9]{32}$/i.test(
                process.env.INVOCATION_ID ?? "",
              )
                ? process.env.INVOCATION_ID
                : undefined,
              sttModel: config.sttModel,
              quickReplyModel: config.quickReplyModel,
              observerModel: config.observerModel,
              taskModel: config.taskModel,
              allParticipantsOperate: config.allParticipantsOperate,
              autonomousTasks: config.autonomousTasks,
            }),
            observe: (observation, options) =>
              codex.observeMeeting(observation, options),
            upsertLiveTranscript,
            upsertMinutes,
            archiveTranscript: (statement) =>
              transcriptArchive.append(statement),
            closeTranscriptArchive: () => transcriptArchive.stop(),
            postText,
            synthesize: audio.synthesize,
            playAudio,
            speak: (text) => (live?.ready ? live.commentary(text) : undefined),
            isLive: () => live?.ready === true,
            stopSpeech: () => live?.silence(),
            onStatement: (statement) => {
              if (!live?.ready) return;
              if (
                /(?:井戸|いど|コーデックス|codex)/iu.test(statement.text) &&
                !/(?:読み上げ|音声).*(?:止め|停止)/u.test(statement.text)
              )
                live.resume();
              live.recordStatement(statement);
            },
            enqueueTask: (task) => taskQueue?.enqueueDurable(task) ?? false,
            controlTask: (control) =>
              taskQueue?.handleVoiceControlDurable(control) ?? false,
            getTaskReceipt: (requestKey) => taskQueue?.getReceipt(requestKey),
            getTaskResult: (taskId) => taskQueue?.getTaskResult(taskId),
            ownerUserId: config.allowedUserId,
            tasksEnabled: config.powerMode,
            operatorUserIds: config.operatorUserIds,
            allParticipantsOperate: config.allParticipantsOperate,
            autonomousTasks: config.autonomousTasks,
            answerUnaddressedQuestions: config.answerUnaddressedQuestions,
            requireWakeWord: config.requireWakeWord,
            initialState: saved?.meeting,
            checkpoint: (meeting) => store?.save({ meeting }),
            getTasks: () => taskQueue?.list() ?? [],
            logger,
            observationIntervalMs: config.observationIntervalMs,
            immediateReactions: config.immediateReactions,
            transcriptionConcurrency: config.transcriptionConcurrency,
            maximumPendingTranscriptions: config.maximumPendingTranscriptions,
            stageTimeouts: config.stageTimeouts,
            scheduleInterval: dependencies.scheduleInterval,
            cancelInterval: dependencies.cancelInterval,
          })
        : new DiscordVoiceSession({
            transcribe: audio.transcribe,
            runCodex: (transcript, options) => codex.run(transcript, options),
            synthesize: audio.synthesize,
            postText,
            playAudio,
            logger,
            maximumQueuedTurns: config.maximumQueuedTurns,
            stageTimeouts: config.stageTimeouts,
          });
    let liveChanging = false;
    const setLiveMode = async (enabled) => {
      if (
        config.voiceMode !== "meeting" ||
        connection.state?.status !== VoiceConnectionStatus.Ready ||
        serviceClosing
      )
        return "unavailable";
      if (liveChanging) return "busy";
      if (enabled && live?.ready) return "live";
      liveChanging = true;
      const fallback = () => {
        playAudio =
          dependencies.playAudio ?? createDiscordPlayer(connection, logger);
        session.dependencies.playAudio = playAudio;
      };
      try {
        live?.close();
        if (!enabled) {
          fallback();
          return "legacy";
        }
        await session.silenceSpeech();
        live = new DiscordLiveBridge({
          apiKey: config.openaiApiKey,
          output: createDiscordLiveOutput(connection, logger),
          logger,
          onDelegation: () => session.observeNow(),
          onFailure: () => {
            fallback();
            logInfoQuietly(logger, {
              component: "discord-voice",
              event: "live_fallback_to_stt_tts",
            });
          },
        });
        await live.start();
        live.thinking(session.getContextSnapshot());
        live.taskState(taskQueue?.list() ?? []);
        return "live";
      } catch {
        fallback();
        logInfoQuietly(logger, {
          component: "discord-voice",
          event: "live_start_failed_using_stt_tts",
        });
        return "failed";
      } finally {
        liveChanging = false;
      }
    };
    if (config.liveEnabled) await setLiveMode(true);
    if (config.voiceMode === "meeting" && session.minutes)
      await upsertMinutes(
        `📝 **議事録・共有コンテキスト（rev ${session.revision}）**\n${boundText(session.minutes, 1750)}\n全文: /ido context または添付`,
        { minutes: session.minutes },
      );
    const handleMessage = createIdobataMessageHandler({
      config,
      session,
      taskQueue,
      resetMeeting: () => codex.resetMeeting?.(),
      setLiveMode,
      leaveVoice: async () => {
        manuallyDisconnected = true;
        live?.close();
        session.voicePaused = true;
        playAudio =
          dependencies.playAudio ?? createDiscordPlayer(connection, logger);
        session.dependencies.playAudio = playAudio;
        await session.silenceSpeech?.();
        connection.disconnect();
      },
      getVoiceStatus: () => {
        const state = connection.state?.status;
        if (serviceClosing || state === VoiceConnectionStatus.Destroyed)
          return "通話: 停止（音声は受信していません）";
        if (manuallyDisconnected)
          return "通話: 退出済み。`/ido join` で接続できます。";
        if (state === VoiceConnectionStatus.Ready)
          return `通話: 接続済み · 音声: ${live?.ready ? "GPT-Live（30分の比較セッション）" : "STT/TTS"}`;
        if (reconnecting) return "通話: 再接続中（音声受信は中断）";
        if (voiceRecoveryFailed || state === VoiceConnectionStatus.Disconnected)
          return "通話: 切断（音声は受信していません）。`/ido reconnect` で再接続を試せます。";
        if (
          state === VoiceConnectionStatus.Connecting ||
          state === VoiceConnectionStatus.Signalling
        )
          return "通話: 接続準備中";
        return "通話: 接続状態は未確認";
      },
      reconnectVoice: async () => {
        if (serviceClosing) return "stopped";
        if (connection.state?.status === VoiceConnectionStatus.Destroyed)
          return "unavailable";
        if (connection.state?.status === VoiceConnectionStatus.Ready)
          return "connected";
        if (reconnecting) return "busy";
        manuallyDisconnected = false;
        session.voicePaused = false;
        reconnecting = true;
        voiceRecoveryFailed = false;
        try {
          if (!connection.rejoin?.())
            throw new Error("Voice rejoin unavailable");
          await (dependencies.entersState ?? entersState)(
            connection,
            VoiceConnectionStatus.Ready,
            20_000,
          );
          return serviceClosing ? "stopped" : "connected";
        } catch {
          if (serviceClosing) return "stopped";
          voiceRecoveryFailed = true;
          return "failed";
        } finally {
          reconnecting = false;
        }
      },
    });
    const handleInteraction = createIdobataInteractionHandler({
      config,
      taskQueue,
    });
    const handleSlash = createIdobataSlashHandler({ config, handleMessage });
    await guild.commands?.create(IDOBATA_APPLICATION_COMMAND);
    client.on?.(Events.InteractionCreate, (interaction) => {
      if (serviceClosing) return;
      trackOperation(
        handleSlash(interaction)
          .then((handled) => handled || handleInteraction(interaction))
          .catch((error) =>
            logAudioFailure(logger, "task_interaction_failed", error),
          ),
      );
    });
    deliveryInterval = setInterval(() => {
      if (!serviceClosing && taskQueue)
        trackOperation(taskQueue.retryResultDelivery());
    }, 30_000);
    deliveryInterval.unref?.();
    if (taskQueue) trackOperation(taskQueue.retryResultDelivery());
    client.on?.(Events.MessageCreate, (message) => {
      if (serviceClosing) return;
      trackOperation(
        handleMessage(message)
          .then((action) => {
            const response = formatDiscordTaskAction(action);
            if (response)
              return message.channel.send(
                createDiscordMessagePayload(response, messageOptions),
              );
          })
          .catch((error) =>
            logAudioFailure(logger, "message_handling_failed", error),
          ),
      );
    });
    subscribeToAllowedSpeaker({
      live: {
        speakerStart: (id) => live?.speakerStart(id),
        speakerEnd: (id) => live?.speakerEnd(id),
        input: (id, chunk) => live?.input(id, chunk),
      },
      connection,
      config,
      session,
      postText,
      logger,
      resolveSpeakerName: (userId) =>
        voiceChannel.members?.get?.(userId)?.displayName ??
        guild.members?.cache?.get?.(userId)?.displayName ??
        userId,
      createDecoder: dependencies.createDecoder,
    });
    await postText(
      config.voiceMode === "meeting"
        ? `🎙️ Discord音声Codexを会議観測モードで起動しました。話者別の認識テキストは日付別の会話ログへ保存し、議事録を更新します。${config.immediateReactions ? "発話後すぐに" : `${Math.round(config.observationIntervalMs / 1_000)}秒ごとに`}必要な場合だけ応答します。${config.powerMode ? "操作担当者の作業依頼は、分離した作業場所でバックグラウンド実行します。" : ""}生の音声ファイルは保存しません。返答音声はAI生成です。`
        : config.listenToEveryone
          ? "🔊 Discord音声Codexを起動しました。ボイスチャンネル内の全参加者の発話を処理します。返答音声はAI生成です。"
          : "🔊 Discord音声Codexを起動しました。本人allowlistの発話だけを処理します。返答音声はAI生成です。",
    );
    if (config.voiceMode === "meeting") await postText(IDOBATA_HELP);
    if (config.allParticipantsOperate || config.autonomousTasks)
      await postText(
        `⚙️ この会議の設定: ${config.allParticipantsOperate ? "参加者全員が作業を指示・操作できます。" : "設定済みの操作担当者が作業を操作できます。"}${config.autonomousTasks ? "会話から必要な作業を判断してタスク化します。" : ""}${config.answerUnaddressedQuestions ? "呼びかけなしの質問にも応答します。" : ""}`,
      );
    logInfoQuietly(logger, {
      component: "discord-voice",
      event: "ready",
      ...describeDiscordVoiceConfig(config),
    });
    return {
      client,
      connection,
      session,
      taskQueue,
      stop: stopService,
    };
  } catch (error) {
    await stopService().catch((failure) =>
      logAudioFailure(logger, "startup_cleanup_failed", failure),
    );
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const service = await startDiscordVoiceCodex();
  const shutdown = async () => {
    await service.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
