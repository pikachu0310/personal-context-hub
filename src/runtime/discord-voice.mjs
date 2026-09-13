import { CodexAgentTeam } from "../discord-agent-team.mjs";
import { AgentWorkerRegistry } from "../discord-agent-worker-registry.mjs";
import { AgentWorkerGateway } from "../discord-agent-worker-gateway.mjs";
import { assertPublicWorkerPolicy } from "../discord-agent-public-policy.mjs";
import { DiscordAgentWebhookPublisher } from "../discord-agent-avatar.mjs";
import { createDistributedTaskRunner } from "../discord-agent-task-runner.mjs";
import { CodexVoiceRunner } from "../execution/codex/runner.mjs";
import { DiscordLiveBridge } from "../providers/live.mjs";
import { TaskPreviewManager } from "../execution/preview.mjs";
import { browserPreviewVerifier } from "../execution/preview-browser.mjs";
import { createDiscordLiveOutput } from "../adapters/discord/transport.mjs";
import { createDiscordTranscriptPublisher } from "../adapters/discord/transcript-publisher.mjs";
import { createConversationEngine } from "../engine/conversation.mjs";
import { createCodexBackend } from "../execution/codex/backend.mjs";
import { bindExecution } from "../execution/port.mjs";
import { discordPresentation } from "../adapters/discord/presentation.mjs";
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
} from "../adapters/discord/transport.mjs";

import { VoiceServiceError } from "../engine/errors.mjs";
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

import { MeetingStateStore, meetingScope } from "../storage/meeting-state.mjs";
import {
  createIdobataMessageHandler,
  createIdobataInteractionHandler,
  IDOBATA_HELP,
  IDOBATA_APPLICATION_COMMAND,
  createIdobataSlashHandler,
} from "../adapters/discord/commands.mjs";
import { readDiscordTokenStore } from "../discord-config.mjs";

import {
  describeDiscordVoiceConfig,
  loadDiscordVoiceConfig,
} from "../discord-voice-config.mjs";
import { createOpenAIAudioAdapter } from "../providers/openai-audio.mjs";
import { boundText } from "../engine/shared.mjs";
import {
  createLocalTranscriptArchive,
  createMeetingTranscriptArchive,
} from "../storage/transcript-archive.mjs";

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
  assertPublicWorkerPolicy(config);
  const store =
    dependencies.meetingStateStore ??
    (config.meetingStatePath
      ? new MeetingStateStore(config.meetingStatePath, meetingScope(config))
      : undefined);
  let saved = await store?.load();
  // Build local adapters before Discord login so unsafe Codex configuration
  // fails closed without joining or sending to a channel.
  const audio = dependencies.audioAdapter ?? createOpenAIAudioAdapter(config);
  const agentTeam =
    dependencies.agentTeam ??
    new CodexAgentTeam(
      config.codexAgents ?? [
        {
          id: "default",
          name: "Codex",
          capabilities: ["*"],
          maximumConcurrentTasks: config.taskConcurrency ?? 1,
          workingDirectory: config.workingDirectory,
          enabled: true,
        },
      ],
    );
  const codexRunner =
    dependencies.codexRunner ??
    (dependencies.executionBackend
      ? undefined
      : new CodexVoiceRunner(config, { agentTeam }));
  const execution = bindExecution(
    dependencies.executionBackend ??
      createCodexBackend(config, { runner: codexRunner }),
  );
  await execution.prepare?.();
  const credential = await (
    dependencies.readCredential ?? readDiscordTokenStore
  )();
  let workerGateway;
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
      const results = await Promise.allSettled([
        Promise.resolve().then(() => workerGateway?.stop?.()),
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
    const workerRegistry =
      dependencies.workerRegistry ??
      new AgentWorkerRegistry({ pairingTtlMs: config.workerPairingTtlMs });
    workerRegistry.restore(saved?.workers);
    for (const worker of workerRegistry.snapshot()) {
      const profile = workerRegistry.describe(worker.agentId);
      if (profile)
        agentTeam.upsert({
          ...profile,
          workingDirectory: config.workingDirectory,
          online: false,
        });
    }
    if (config.workerGatewayEnabled) {
      workerGateway =
        dependencies.workerGateway ??
        new AgentWorkerGateway({
          registry: workerRegistry,
          agentTeam,
          host: config.workerGatewayHost,
          port: config.workerGatewayPort,
          publicUrl: config.workerGatewayPublicUrl,
          authorizeOwner: (ownerUserId) =>
            Boolean(ownerUserId) &&
            (config.allParticipantsOperate ||
              ownerUserId === config.allowedUserId ||
              (config.operatorUserIds ?? []).includes(ownerUserId)),
          defaultWorkingDirectory: config.workingDirectory,
          heartbeatTimeoutMs: config.workerHeartbeatTimeoutMs,
          leaseTtlMs: config.workerLeaseTtlMs,
          checkpoint: (workers) => store?.save({ workers }),
          onAvailability: () => taskQueue?.resume?.(),
          logger,
        });
      await workerGateway.start?.();
    }
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
    const agentChannelIds = [
      ...new Set(
        (config.codexAgents ?? [])
          .map(({ channelId }) => channelId)
          .filter(Boolean),
      ),
    ];
    const [
      voiceChannel,
      textChannel,
      issueForum,
      coordinationChannel,
      ...agentChannelValues
    ] = await Promise.all([
      guild.channels.fetch(config.voiceChannelId),
      guild.channels.fetch(config.textChannelId),
      config.issueForumChannelId
        ? guild.channels.fetch(config.issueForumChannelId)
        : undefined,
      config.agentCoordinationChannelId
        ? guild.channels.fetch(config.agentCoordinationChannelId)
        : undefined,
      ...agentChannelIds.map((channelId) => guild.channels.fetch(channelId)),
    ]);
    if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
      throw new Error("Configured voice channel is not a Guild Voice channel.");
    }
    if (!textChannel?.isTextBased() || typeof textChannel.send !== "function") {
      throw new Error("Configured text channel cannot receive Bot messages.");
    }
    if (
      config.issueForumChannelId &&
      (!issueForum ||
        issueForum.type !== ChannelType.GuildForum ||
        typeof issueForum.threads?.create !== "function")
    ) {
      throw new Error(
        "PERSONAL_CONTEXT_VOICE_ISSUE_FORUM_CHANNEL_ID must identify a Discord Forum channel.",
      );
    }
    if (
      config.agentCoordinationChannelId &&
      (!coordinationChannel?.isTextBased?.() ||
        typeof coordinationChannel.send !== "function")
    ) {
      throw new Error(
        "PERSONAL_CONTEXT_VOICE_AGENT_CHANNEL_ID cannot receive Bot messages.",
      );
    }
    const channelById = new Map(
      agentChannelIds.map((channelId, index) => [
        channelId,
        agentChannelValues[index],
      ]),
    );
    const agentChannels = new Map(
      (config.codexAgents ?? [])
        .filter(({ channelId }) => channelId)
        .map((agent) => [agent.id, channelById.get(agent.channelId)]),
    );
    for (const [agentId, channel] of agentChannels) {
      if (!agentId || !channel?.isTextBased?.() || !channel.send)
        throw new Error(
          `Codex agent ${agentId ?? "unknown"} channel is invalid.`,
        );
    }
    const messageOptions = { silent: config.silentMessages !== false };
    const agentMessagePublisher =
      issueForum && config.agentWebhookAvatars
        ? (dependencies.agentMessagePublisher ??
          new DiscordAgentWebhookPublisher({
            issueForum,
            agentTeam,
          }))
        : undefined;
    const postText = (content, { idempotencyKey } = {}) =>
      textChannel.send(
        createDiscordMessagePayload(content, {
          ...messageOptions,
          idempotencyKey,
        }),
      );
    const createTaskThread = createDiscordTaskThread(textChannel, {
      ...messageOptions,
      issueForum,
      coordinationChannel,
      agentChannels,
      agentMessagePublisher,
    });
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
    playAudio =
      dependencies.playAudio ?? createDiscordPlayer(connection, logger, config);
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
    const distributedRunTask = createDistributedTaskRunner({
      localRunner: (task, options) => execution.runTask(task, options),
      workerGateway,
      agentTeam,
      listTasks: () => taskQueue?.snapshot() ?? [],
    });
    const engine = await createConversationEngine({
      config,
      audio,
      execution: {
        ...execution,
        reviewTask: (task, options) => codexRunner?.reviewTask?.(task, options),
        runTask: async (task, options) => {
          await previews.stop(task.id, "superseded");
          const result = await distributedRunTask(task, options);
          try {
            if (!task.remoteExecution) await previews.start(task, options);
          } catch {
            task.preview = { state: "failed", runRevision: task.runRevision };
          }
          return result;
        },
        confirmPreview: (task, revision, userId) =>
          previews.confirm(task, revision, userId),
        invalidatePreview: (task, state = "superseded") =>
          previews.stop(task.id, state),
      },
      store,
      initialState: saved,
      transcriptArchive,
      logger,
      dependencies: { ...dependencies, agentTeam },
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
          const starter =
            task.surfaceType === "forum"
              ? await thread.fetchStarterMessage?.().catch(() => undefined)
              : task.starterId
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
            {
              ...messageOptions,
              fallbackChannel:
                task.surfaceType === "forum" ? thread : textChannel,
            },
          );
          const postAs = async (agentId, content, options = {}) => {
            if (options.signal?.aborted) throw options.signal.reason;
            if (agentMessagePublisher && agentId) {
              const sent = await agentMessagePublisher
                .post(agentId, thread, content, {
                  ...options,
                  issueId: task.issueId ?? task.id,
                })
                .catch(() => undefined);
              if (sent) return sent;
            }
            return thread.send(
              createDiscordMessagePayload(content, {
                ...messageOptions,
                idempotencyKey: options.idempotencyKey,
              }),
            );
          };
          return {
            threadId: task.threadId,
            surfaceType: task.surfaceType,
            postAs,
            get starterId() {
              return card.starterId;
            },
            postArtifacts: createDiscordArtifactPoster(
              thread,
              task,
              messageOptions,
            ),
            post: (content, options) =>
              postAs(task.assignedAgentId, content, options),
            update: card.update,
          };
        },
      },
    });
    session = engine.session;
    taskQueue = engine.taskQueue;
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
      workerGateway,
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
      workerGateway,
      agentTeam,
      client,
      connection,
      session,
      taskQueue,
      input: engine.input,
      stop: stopService,
    };
  } catch (error) {
    await stopService().catch((failure) =>
      logAudioFailure(logger, "startup_cleanup_failed", failure),
    );
    throw error;
  }
}
