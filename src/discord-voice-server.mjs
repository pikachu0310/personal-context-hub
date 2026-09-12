import { Readable } from "node:stream";
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
} from "discord.js";
import prism from "prism-media";
import { MeetingStateStore, meetingScope } from "./discord-voice-state.mjs";
import {
  createIdobataMessageHandler,
  createIdobataInteractionHandler,
  taskControls,
  IDOBATA_HELP,
} from "./discord-voice-commands.mjs";
import { readDiscordTokenStore } from "./discord-config.mjs";
import {
  PcmTurnBuffer,
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

export function createDiscordPlayer(connection, logger = console) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  player.on("error", (error) => {
    logAudioFailure(logger, "playback_failed", error);
  });
  connection.subscribe(player);
  return async (ttsPcm, { signal } = {}) => {
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
}) {
  const active = new Set();
  const notify = (content) =>
    Promise.resolve()
      .then(() => postText(content))
      .catch(() => undefined);
  connection.receiver.speaking.on("start", (userId) => {
    if (
      (!config.listenToEveryone && userId !== config.allowedUserId) ||
      active.has(userId)
    )
      return;
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
    const turnBuffer = new PcmTurnBuffer(config);
    let discardedTurn = false;
    let finalized = false;

    decoder.on("data", (chunk) => {
      if (discardedTurn) return;
      try {
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
        active.delete(userId);
        opusStream.destroy();
        decoder.destroy();
        logAudioFailure(logger, "receive_frame_failed", error);
        void notify(AUDIO_RETRY_MESSAGE);
      }
    });
    const release = () => active.delete(userId);
    opusStream.once("error", (error) => {
      discardedTurn = true;
      finalized = true;
      release();
      decoder.destroy();
      logAudioFailure(logger, "receive_failed", error);
      void notify(AUDIO_RETRY_MESSAGE);
    });
    opusStream.once("close", release);
    decoder.once("close", release);
    decoder.once("error", (error) => {
      discardedTurn = true;
      finalized = true;
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
        logAudioFailure(logger, "receive_finalize_failed", error);
        void notify(AUDIO_RETRY_MESSAGE);
      }
    });
    opusStream.pipe(decoder);
  });
}

export function createDiscordMessagePayload(content, { silent = true } = {}) {
  return {
    content,
    allowedMentions: { parse: [] },
    ...(silent ? { flags: MessageFlags.SuppressNotifications } : {}),
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
    } catch {
      message = await textChannel.send(payload);
    }
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
  const [icon, label] = DISCORD_TASK_STATES[state] ?? ["🧰", state];
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
  ].join("\n");
}

export function createDiscordArtifactPoster(
  thread,
  task,
  { silent = true } = {},
) {
  return async (artifacts, evidence) => {
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
          { silent },
        ),
      );
      return;
    }
    await thread.send({
      ...createDiscordMessagePayload(
        `📎 実行版 ${artifacts.runRevision ?? 1} の差分と検証記録。前回反映した時点（未反映なら開始時点）からの変更です。確認後 \`/ido apply ${task.id} ${artifacts.runRevision ?? 1}\` で反映できます。`,
        { silent },
      ),
      files: [
        {
          attachment: patch.length
            ? patch
            : Buffer.from("# No tracked-file diff\n"),
          name: `${task.id}-r${artifacts.runRevision ?? 1}.patch`,
        },
        {
          attachment: Buffer.from(JSON.stringify(evidence ?? {}, null, 2)),
          name: `${task.id}-r${artifacts.runRevision ?? 1}-verification.json`,
        },
      ],
    });
  };
}

export function createDiscordTaskThread(textChannel, { silent = true } = {}) {
  return async (task) => {
    const title = String(task.title ?? "Codexタスク")
      .replace(/[\r\n]+/g, " ")
      .trim();
    let starter = await textChannel.send(
      createDiscordMessagePayload(formatDiscordTaskCard(task), { silent }),
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
      await starter
        .edit({
          content: formatDiscordTaskCard(task, { state: "failed" }),
          allowedMentions: { parse: [] },
        })
        .catch(() => undefined);
      throw error;
    }
    const threadId = String(thread.id ?? "");
    if (!threadId) throw new Error("Created task thread has no channel ID.");
    const update = async ({
      state,
      elapsedMs,
      pendingInstructions,
      signal,
    } = {}) => {
      if (signal?.aborted) throw signal.reason;
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
        ),
      };
      try {
        starter = await starter.edit(payload);
      } catch {
        starter = await textChannel.send({
          ...createDiscordMessagePayload(payload.content, { silent }),
          components: payload.components,
        });
        await task.checkpoint?.();
      }
      return starter;
    };
    const post = (content, { signal } = {}) => {
      if (signal?.aborted) return Promise.reject(signal.reason);
      return thread.send(createDiscordMessagePayload(content, { silent }));
    };
    try {
      await update({ state: "queued" });
      const request = escapeDiscordMarkdown(
        boundText(task.request, 1_200) || "依頼内容を取得できませんでした。",
      );
      await post(`🧾 **依頼内容**\n${request}`);
      await post(
        [
          "💡 **このスレッドで操作できます**",
          "追加指示: そのままメッセージを送信",
          "停止: `停止` / `中止` / `キャンセル` / `stop` / `cancel`",
          "実行中の追加指示は、現在の処理が終わり次第、同じCodexセッションで続けます。",
        ].join("\n"),
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
        return starter.id;
      },
    };
  };
}

export function formatDiscordTaskAction(action) {
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
      GatewayIntentBits.MessageContent,
    ],
  }),
  logger = console,
  dependencies = {},
} = {}) {
  const store = config.meetingStatePath
    ? new MeetingStateStore(config.meetingStatePath, meetingScope(config))
    : undefined;
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
  let deliveryInterval;
  let loginAttempted = false;
  let serviceClosing = false;
  let reconnecting = false;
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
    const postText = (content) =>
      textChannel.send(createDiscordMessagePayload(content, messageOptions));
    const createTaskThread = createDiscordTaskThread(
      textChannel,
      messageOptions,
    );
    const upsertLiveTranscript = createEditableDiscordPost(
      textChannel,
      messageOptions,
    );
    const upsertMinutes = createEditableDiscordPost(
      textChannel,
      messageOptions,
    );
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
      if (serviceClosing || reconnecting) return;
      reconnecting = true;
      const waitForState = dependencies.entersState ?? entersState;
      void (async () => {
        try {
          await Promise.race([
            waitForState(connection, VoiceConnectionStatus.Signalling, 5_000),
            waitForState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          await waitForState(connection, VoiceConnectionStatus.Ready, 20_000);
        } catch {
          if (serviceClosing) return;
          try {
            if (!connection.rejoin?.())
              throw new Error("Voice rejoin unavailable");
            await waitForState(connection, VoiceConnectionStatus.Ready, 20_000);
          } catch {
            await postText(
              "⚠️ 通話との接続が切れ、再接続できませんでした。音声は受信していません。テキストで作業を続けられます。通話を復旧するにはBotを再起動してください。",
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
    const playAudio =
      dependencies.playAudio ?? createDiscordPlayer(connection, logger);
    taskQueue = config.powerMode
      ? new DiscordVoiceTaskQueue({
          runTask: (task, options) => codex.runTask(task, options),
          postText,
          createTaskThread,
          logger,
          concurrency: config.taskConcurrency,
          maximumPendingTasks: config.maximumPendingTasks,
          taskTimeoutMs: config.stageTimeouts.running_codex,
          checkpoint: (tasks) => store?.save({ tasks }),
          onResult: (result) => session?.addTaskResult?.(result),
          applyTask: (task) => codex.applyTask(task),
        })
      : undefined;
    if (taskQueue && saved?.tasks?.length) {
      await taskQueue.restore(saved.tasks, async (task) => {
        if (!task.threadId || !task.starterId)
          throw new Error("Task has no Discord surface");
        const thread = await guild.channels.fetch(task.threadId);
        const starter = await textChannel.messages.fetch(task.starterId);
        return {
          threadId: task.threadId,
          starterId: task.starterId,
          postArtifacts: createDiscordArtifactPoster(
            thread,
            task,
            messageOptions,
          ),
          post: (content) =>
            thread.send(createDiscordMessagePayload(content, messageOptions)),
          update: (state) =>
            starter.edit({
              content: formatDiscordTaskCard(task, {
                ...state,
                threadId: task.threadId,
              }),
              allowedMentions: { parse: [] },
              components: taskControls(
                task.id,
                state.state,
                task.artifacts?.runRevision,
                Boolean(
                  task.appliedRevision &&
                  task.appliedRevision === task.artifacts?.runRevision,
                ),
              ),
            }),
        };
      });
    }
    session =
      config.voiceMode === "meeting"
        ? new DiscordVoiceMeetingSession({
            transcribe: audio.transcribe,
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
            enqueueTask: (task) => taskQueue?.enqueueDurable(task) ?? false,
            controlTask: (control) =>
              taskQueue?.handleVoiceControl(control) ?? false,
            ownerUserId: config.allowedUserId,
            tasksEnabled: config.powerMode,
            operatorUserIds: config.operatorUserIds,
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
    const handleMessage = createIdobataMessageHandler({
      config,
      session,
      taskQueue,
      resetMeeting: () => codex.resetMeeting?.(),
    });
    const handleInteraction = createIdobataInteractionHandler({
      config,
      taskQueue,
    });
    client.on?.(Events.InteractionCreate, (interaction) => {
      void handleInteraction(interaction).catch((error) =>
        logAudioFailure(logger, "task_interaction_failed", error),
      );
    });
    deliveryInterval = setInterval(
      () => void taskQueue?.retryResultDelivery(),
      30_000,
    );
    deliveryInterval.unref?.();
    void taskQueue?.retryResultDelivery();
    client.on?.(Events.MessageCreate, (message) => {
      void handleMessage(message)
        .then((action) => {
          const response = formatDiscordTaskAction(action);
          if (response)
            return message.channel.send(
              createDiscordMessagePayload(response, messageOptions),
            );
        })
        .catch((error) =>
          logAudioFailure(logger, "message_handling_failed", error),
        );
    });
    subscribeToAllowedSpeaker({
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
    logInfoQuietly(logger, {
      component: "discord-voice",
      event: "ready",
      ...describeDiscordVoiceConfig(config),
    });
    let stopped = false;
    return {
      client,
      connection,
      session,
      taskQueue,
      async stop() {
        if (stopped) return;
        stopped = true;
        serviceClosing = true;
        clearInterval(deliveryInterval);
        await session.stop();
        await taskQueue?.stop?.();
        await store?.release();
        await Promise.all([destroyQuietly(connection), destroyQuietly(client)]);
      },
    };
  } catch (error) {
    serviceClosing = true;
    clearInterval(deliveryInterval);
    await Promise.allSettled([
      session?.stop?.(),
      taskQueue?.stop?.(),
      transcriptArchive?.stop?.(),
      store?.release(),
      destroyQuietly(connection),
      loginAttempted ? destroyQuietly(client) : Promise.resolve(),
    ]);
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
