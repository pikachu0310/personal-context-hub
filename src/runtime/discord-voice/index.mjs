import { startHudServer, createHudStore } from "../hud-server.mjs";
import { startStudioServer } from "../studio-server.mjs";
import { createPreviewRelay } from "../preview-relay.mjs";
import { readStudioAccess } from "../studio-access.mjs";
import { createStudioController } from "../../adapters/browser/controller.mjs";
import { DiscordLiveBridge } from "../../providers/live.mjs";
import {
  createDiscordDiscussionRouter,
  createThreadParticipantJoiner,
  taskParticipantIds,
} from "../../adapters/discord/discussion-threads.mjs";
import { TaskPreviewManager } from "../../execution/preview.mjs";
import { browserPreviewVerifier } from "../../execution/preview-browser.mjs";
import { createDiscordLiveOutput } from "../../adapters/discord/transport.mjs";
import { createDiscordTranscriptPublisher } from "../../adapters/discord/transcript-publisher.mjs";
import { createConversationEngine } from "../../engine/conversation.mjs";
import { createCodexBackend } from "../../execution/codex/backend.mjs";
import { bindExecution } from "../../execution/port.mjs";
import { discordPresentation } from "../../adapters/discord/presentation.mjs";
import {
  createDiscordPlayer,
  createDiscordMessagePayload,
  createDiscordTaskThread,
  createEditableDiscordPost,
  createMinutesDiscordPost,
  createDiscordTaskCardUpdater,
  createDiscordArtifactPoster,
  formatDiscordTaskAction,
  subscribeToAllowedSpeaker,
  logAudioFailure,
  logInfoQuietly,
  destroyQuietly,
} from "../../adapters/discord/transport.mjs";

import { VoiceServiceError } from "../../engine/errors.mjs";
import { once } from "node:events";

import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  RESTJSONErrorCodes,
} from "discord.js";

import {
  MeetingStateStore,
  meetingScope,
} from "../../storage/meeting-state.mjs";
import {
  createIdobataMessageHandler,
  createIdobataInteractionHandler,
  IDOBATA_APPLICATION_COMMAND,
  createIdobataSlashHandler,
} from "../../adapters/discord/commands.mjs";
import { readDiscordTokenStore } from "../../integrations/discord-bot/config.mjs";

import {
  describeDiscordVoiceConfig,
  loadDiscordVoiceConfig,
} from "./config.mjs";
import { createOpenAIAudioAdapter } from "../../providers/openai-audio.mjs";
import { boundText } from "../../engine/shared.mjs";
import {
  createLocalTranscriptArchive,
  createMeetingTranscriptArchive,
} from "../../storage/transcript-archive.mjs";

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
  const execution = bindExecution(
    dependencies.executionBackend ??
      createCodexBackend(config, { runner: dependencies.codexRunner }),
  );
  await execution.prepare?.();
  const credential = await (
    dependencies.readCredential ?? readDiscordTokenStore
  )();
  let hud;
  const hudStore = createHudStore();
  let studio, studioController, previewRelay;
  let connection;
  let transcriptArchive;
  let session;
  let taskQueue;
  let playAudio;
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
    playAudio?.dispose?.();
    stopping = (async () => {
      await studio?.close();
      const results = await Promise.allSettled([
        Promise.resolve().then(() => studioController?.close()),
        Promise.resolve().then(() => previews?.close()),
        Promise.resolve().then(() => session?.stop?.()),
        Promise.resolve().then(() => taskQueue?.stop?.()),
        ...pendingOperations,
        ...(!session
          ? [Promise.resolve().then(() => transcriptArchive?.stop?.())]
          : []),
      ]);
      await hud?.close();
      await previewRelay?.close();
      const failures = results
        .filter((result) => result.status === "rejected")
        .map((result) => result.reason);
      try {
        await execution.close?.();
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
    const postText = createDiscordDiscussionRouter({
      textChannel,
      botUserId: client.user?.id,
      getTask: (id) => taskQueue?.list().find((task) => task.id === id),
      createMessagePayload: (content, { idempotencyKey } = {}) =>
        createDiscordMessagePayload(content, {
          ...messageOptions,
          idempotencyKey,
        }),
    });
    const joinParticipants = createThreadParticipantJoiner();
    const upsertStatus = createEditableDiscordPost(textChannel, {
      ...messageOptions,
      botUserId: client.user?.id,
      restorePrefix: "🎙️ **井戸Bot",
    });
    const createTaskThread = createDiscordTaskThread(
      textChannel,
      messageOptions,
    );
    const upsertLiveTranscript = createEditableDiscordPost(textChannel, {
      ...messageOptions,
      botUserId: client.user?.id,
      restorePrefix: "🎙️ **会話ログ・処理状況**",
    });
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
    playAudio =
      dependencies.playAudio ?? createDiscordPlayer(connection, logger, config);
    if (config.studioPort !== undefined) {
      previewRelay = createPreviewRelay({
        host: config.studioHost ?? "127.0.0.1",
        publicHost: config.studioPublicOrigin
          ? new URL(config.studioPublicOrigin).hostname
          : "127.0.0.1",
      });
    }
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
        await previewRelay?.expose(task);
        await task.checkpoint?.();
        await task.surface?.update?.({
          state: task.state,
          pendingInstructions: task.instructions.length,
        });
      },
    });
    const hudPort =
      config.hudPort ?? process.env.PERSONAL_CONTEXT_VOICE_HUD_PORT;
    if (hudPort !== undefined && hudPort !== "") {
      try {
        hud = await startHudServer({ port: Number(hudPort), store: hudStore });
        logInfoQuietly(logger, {
          component: "voice-hud",
          event: "ready",
          url: hud.url,
        });
      } catch {
        logInfoQuietly(logger, {
          component: "voice-hud",
          event: "unavailable",
        });
      }
    }
    const engine = await createConversationEngine({
      onEvent: (event) => hudStore.publish(event),
      config,
      audio,
      execution: {
        ...execution,
        runTask: async (task, options) => {
          await previews.stop(task.id, "superseded");
          const result = await execution.runTask(task, options);
          try {
            await previews.start(task, options);
          } catch {
            task.preview = { state: "failed", runRevision: task.runRevision };
          }
          return result;
        },
        confirmPreview: (task, revision, userId) =>
          previews.confirm(task, revision, userId),
        restartPreview: (task) => previews.start(task),
        invalidatePreview: (task, state = "superseded") =>
          previews.stop(task.id, state),
      },
      store,
      initialState: saved,
      transcriptArchive,
      logger,
      dependencies,
      hooks: {
        onTaskState: (tasks) => live?.taskState(tasks),
        onTaskResult: (result) => {
          if (result.meetingId === session?.meetingId) live?.taskResult(result);
        },
        getRuntimeContext: () => ({
          voiceStatus: connection.state?.status,
          manuallyDisconnected,
          reconnecting,
          voiceRecoveryFailed,
          invocationId: /^[a-f0-9]{32}$/i.test(process.env.INVOCATION_ID ?? "")
            ? process.env.INVOCATION_ID
            : undefined,
          sttModel: config.sttModel,
          quickReplyModel: config.quickReplyModel,
          observerModel: config.observerModel,
          taskModel: config.taskModel,
          allParticipantsOperate: config.allParticipantsOperate,
          autonomousTasks: config.autonomousTasks,
        }),
        onStatement: (statement) => {
          if (!live?.ready) return;
          if (
            /(?:井戸|いど|コーデックス|codex)/iu.test(statement.text) &&
            !/(?:読み上げ|音声).*(?:止め|停止)/u.test(statement.text)
          )
            live.resume();
          live.recordStatement(statement);
        },
      },
      output: {
        capabilities: {
          audio: true,
          transcript: true,
          minutes: true,
          tasks: true,
          threadedResults: true,
        },
        presentation: discordPresentation,
        postText,
        createTaskThread,
        upsertLiveTranscript,
        upsertMinutes,
        playAudio,
        speak: (text) => (live?.ready ? live.commentary(text) : undefined),
        isLive: () => live?.ready === true,
        stopSpeech: () => live?.silence(),
        restoreTaskSurface: async (task) => {
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
          await joinParticipants(thread, taskParticipantIds(task));
          const starter = task.starterId
            ? await textChannel.messages
                .fetch(task.starterId)
                .catch((error) => {
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
        },
      },
    });
    session = engine.session;
    taskQueue = engine.taskQueue;
    if (config.studioPort !== undefined) {
      studioController = createStudioController({
        engine,
        store,
        initialState: saved,
        hudStore,
        name: config.studioName ?? "井戸Botの共有スタジオ",
      });
      const access =
        dependencies.studioAccess ??
        (await readStudioAccess(`${config.statePath}.studio-access.json`));
      studio = await startStudioServer({
        rooms: new Map([
          [
            "current",
            {
              name: config.studioName ?? "井戸Botの共有スタジオ",
              controller: studioController,
            },
          ],
        ]),
        port: config.studioPort,
        host: config.studioHost ?? "127.0.0.1",
        publicOrigin: config.studioPublicOrigin,
        ...access,
      });
      logInfoQuietly(logger, {
        component: "voice-studio",
        event: "ready",
        url: studio.url,
      });
    }
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
        playAudio?.dispose?.();
        playAudio =
          dependencies.playAudio ??
          createDiscordPlayer(connection, logger, config);
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
      input: engine.input,
      config,
      session,
      taskQueue,
      resetMeeting: () => execution.resetMeeting?.(),
      setLiveMode,
      leaveVoice: async () => {
        manuallyDisconnected = true;
        live?.close();
        session.voicePaused = true;
        playAudio?.dispose?.();
        playAudio =
          dependencies.playAudio ??
          createDiscordPlayer(connection, logger, config);
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
      session: engine.input,
      postText,
      logger,
      resolveSpeakerName: (userId) =>
        voiceChannel.members?.get?.(userId)?.displayName ??
        guild.members?.cache?.get?.(userId)?.displayName ??
        userId,
      createDecoder: dependencies.createDecoder,
    });
    await upsertStatus(
      config.voiceMode === "meeting"
        ? `🎙️ **井戸Bot・会議の案内**\n即答は明示的な呼びかけ・質問コマンドに限ります。通常の会話は${Math.round(config.observationIntervalMs / 1000)}秒ごとに整理し、必要な確認結果を回答スレッドへ届けます。${config.powerMode ? "作業はBotへの依頼・委任が確定した場合に開始し、結果は各タスクのスレッドへまとめます。" : ""}\n議事録: /ido context · 作業一覧: /ido status · 操作説明: /ido help\n${config.allParticipantsOperate ? "参加者全員が作業を指示・操作できます。" : "設定済みの操作担当者が作業を操作できます。"}認識テキストは日付別の会話ログに保存します。生の音声は保存せず、返答音声はAI生成です。`
        : config.listenToEveryone
          ? "🔊 Discord音声Codexを起動しました。ボイスチャンネル内の全参加者の発話を処理します。返答音声はAI生成です。"
          : "🔊 Discord音声Codexを起動しました。本人allowlistの発話だけを処理します。返答音声はAI生成です。",
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
      input: engine.input,
      hud,
      studio,
      stop: stopService,
    };
  } catch (error) {
    await stopService().catch((failure) =>
      logAudioFailure(logger, "startup_cleanup_failed", failure),
    );
    throw error;
  }
}
