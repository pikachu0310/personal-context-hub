import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { automaticVoiceModel } from "./discord-voice-model-policy.mjs";
import { parsePreviewCommand } from "./discord-voice-preview.mjs";
import { parsePreviewChecks } from "./discord-voice-preview-browser.mjs";
import { parseCodexAgents } from "./discord-agent-team.mjs";

const snowflake = /^\d{17,20}$/;
const codexReasoningEfforts = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optionalSnowflake(env, name) {
  return String(env[name] ?? "").trim()
    ? requiredSnowflake(env, name)
    : undefined;
}

function requiredSnowflake(env, name) {
  const value = required(env, name);
  if (!snowflake.test(value))
    throw new Error(`${name} must be a Discord snowflake.`);
  return value;
}

function integer(env, name, fallback, minimum, maximum) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

function number(env, name, fallback, minimum, maximum) {
  const value = env[name] === undefined ? fallback : Number(env[name]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(
      `${name} must be a number from ${minimum} through ${maximum}.`,
    );
  }
  return value;
}

function boolean(env, name, fallback) {
  if (env[name] === undefined) return fallback;
  const value = env[name].trim().toLowerCase();
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false.`);
}

function absolutePath(value, name) {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return resolve(value);
}

function reasoningEffort(env, name, fallback) {
  const value = env[name]?.trim().toLowerCase() || fallback;
  if (value && !codexReasoningEfforts.has(value))
    throw new Error(
      `${name} must be minimal, low, medium, high, xhigh, max, or ultra.`,
    );
  return value;
}

export function loadDiscordVoiceConfig(env = process.env) {
  const workingDirectory = absolutePath(
    required(env, "PERSONAL_CONTEXT_VOICE_WORKDIR"),
    "PERSONAL_CONTEXT_VOICE_WORKDIR",
  );
  const statePath = resolve(
    env.PERSONAL_CONTEXT_VOICE_STATE_PATH ??
      join(
        homedir(),
        ".local",
        "state",
        "personal-context-hub",
        "discord-voice-codex.json",
      ),
  );
  const isolatedCodexHome =
    env.PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME?.trim()
      ? absolutePath(
          env.PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME,
          "PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME",
        )
      : join(dirname(statePath), "discord-voice-codex-home");
  const powerMode = boolean(env, "PERSONAL_CONTEXT_VOICE_POWER_MODE", false);
  const codexSandbox =
    env.PERSONAL_CONTEXT_VOICE_CODEX_SANDBOX?.trim() ||
    (powerMode ? "danger-full-access" : "workspace-write");
  if (
    !new Set(["read-only", "workspace-write", "danger-full-access"]).has(
      codexSandbox,
    ) ||
    (codexSandbox === "danger-full-access" && !powerMode)
  ) {
    throw new Error(
      "PERSONAL_CONTEXT_VOICE_CODEX_SANDBOX must be read-only or workspace-write unless power mode explicitly enables danger-full-access.",
    );
  }
  const voiceMode = env.PERSONAL_CONTEXT_VOICE_MODE?.trim() || "turn";
  if (!new Set(["turn", "meeting"]).has(voiceMode)) {
    throw new Error("PERSONAL_CONTEXT_VOICE_MODE must be turn or meeting.");
  }
  const codexReasoningEffort = reasoningEffort(
    env,
    "PERSONAL_CONTEXT_VOICE_CODEX_REASONING_EFFORT",
    "low",
  );
  const codexModel = automaticVoiceModel(
    env.PERSONAL_CONTEXT_VOICE_CODEX_MODEL?.trim(),
  );
  const taskModel = automaticVoiceModel(
    env.PERSONAL_CONTEXT_VOICE_TASK_MODEL?.trim() ||
      codexModel ||
      "gpt-5.6-sol",
  );
  const taskReasoningEffort = reasoningEffort(
    env,
    "PERSONAL_CONTEXT_VOICE_TASK_REASONING_EFFORT",
    codexReasoningEffort ?? "low",
  );
  const codexTimeoutMs = integer(
    env,
    "PERSONAL_CONTEXT_VOICE_CODEX_TIMEOUT_MS",
    900_000,
    30_000,
    3_600_000,
  );
  const taskConcurrency = integer(
    env,
    "PERSONAL_CONTEXT_VOICE_TASK_CONCURRENCY",
    2,
    1,
    4,
  );
  const codexAgents = parseCodexAgents(
    env.PERSONAL_CONTEXT_VOICE_CODEX_AGENTS,
    {
      workingDirectory,
      model: taskModel,
      reasoningEffort: taskReasoningEffort,
      maximumConcurrentTasks: taskConcurrency,
    },
  );
  return {
    guildId: requiredSnowflake(env, "PERSONAL_CONTEXT_VOICE_GUILD_ID"),
    voiceChannelId: requiredSnowflake(env, "PERSONAL_CONTEXT_VOICE_CHANNEL_ID"),
    textChannelId: requiredSnowflake(
      env,
      "PERSONAL_CONTEXT_VOICE_TEXT_CHANNEL_ID",
    ),
    issueForumChannelId: optionalSnowflake(
      env,
      "PERSONAL_CONTEXT_VOICE_ISSUE_FORUM_CHANNEL_ID",
    ),
    agentCoordinationChannelId: optionalSnowflake(
      env,
      "PERSONAL_CONTEXT_VOICE_AGENT_CHANNEL_ID",
    ),
    workerGatewayEnabled: boolean(
      env,
      "PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_ENABLED",
      false,
    ),
    agentJoinGuideUrl: env.PERSONAL_CONTEXT_VOICE_AGENT_JOIN_GUIDE_URL?.trim(),
    workerGatewayHost:
      env.PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_HOST?.trim() || "127.0.0.1",
    workerGatewayPort: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_PORT",
      8787,
      1,
      65_535,
    ),
    workerGatewayPublicUrl:
      env.PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_PUBLIC_URL?.trim() ||
      `ws://${env.PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_HOST?.trim() || "127.0.0.1"}:${integer(
        env,
        "PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_PORT",
        8787,
        1,
        65_535,
      )}`,
    workerPairingTtlMs: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_WORKER_PAIRING_TTL_MS",
      300_000,
      60_000,
      900_000,
    ),
    workerHeartbeatTimeoutMs: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_WORKER_HEARTBEAT_TIMEOUT_MS",
      45_000,
      15_000,
      300_000,
    ),
    workerLeaseTtlMs: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_WORKER_LEASE_TTL_MS",
      120_000,
      30_000,
      900_000,
    ),
    agentWebhookAvatars: boolean(
      env,
      "PERSONAL_CONTEXT_VOICE_AGENT_WEBHOOK_AVATARS",
      true,
    ),
    allowedUserId: requiredSnowflake(env, "PERSONAL_CONTEXT_VOICE_USER_ID"),
    listenToEveryone: boolean(
      env,
      "PERSONAL_CONTEXT_VOICE_LISTEN_TO_EVERYONE",
      false,
    ),
    powerMode,
    voiceMode,
    liveEnabled:
      voiceMode === "meeting" &&
      boolean(env, "PERSONAL_CONTEXT_VOICE_LIVE_ENABLED", false),
    previewCommand: parsePreviewCommand(
      env.PERSONAL_CONTEXT_VOICE_PREVIEW_COMMAND_JSON,
    ),
    previewChecks: parsePreviewChecks(
      env.PERSONAL_CONTEXT_VOICE_PREVIEW_CHECKS_JSON,
    ),
    previewBrowserExecutable:
      env.PERSONAL_CONTEXT_VOICE_PREVIEW_BROWSER_EXECUTABLE?.trim() ||
      undefined,
    previewSharedUrlTemplate:
      env.PERSONAL_CONTEXT_VOICE_PREVIEW_SHARED_URL_TEMPLATE?.trim() ||
      undefined,
    operatorUserIds: (env.PERSONAL_CONTEXT_VOICE_OPERATOR_IDS ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
      .map((id) => {
        if (!snowflake.test(id))
          throw new Error(
            "PERSONAL_CONTEXT_VOICE_OPERATOR_IDS must contain Discord snowflakes.",
          );
        return id;
      }),
    requireWakeWord: boolean(
      env,
      "PERSONAL_CONTEXT_VOICE_REQUIRE_WAKE_WORD",
      true,
    ),
    allParticipantsOperate: boolean(
      env,
      "PERSONAL_CONTEXT_VOICE_ALL_PARTICIPANTS_OPERATE",
      false,
    ),
    autonomousTasks: boolean(
      env,
      "PERSONAL_CONTEXT_VOICE_AUTONOMOUS_TASKS",
      false,
    ),
    answerUnaddressedQuestions: boolean(
      env,
      "PERSONAL_CONTEXT_VOICE_ANSWER_UNADDRESSED_QUESTIONS",
      false,
    ),
    meetingStatePath: `${statePath}.meeting.json`,
    taskWorkspaceDirectory: `${statePath}.workspaces`,
    observerModel: automaticVoiceModel(
      env.PERSONAL_CONTEXT_VOICE_OBSERVER_MODEL?.trim() ||
        codexModel ||
        "gpt-5.6-sol",
    ),
    observerReasoningEffort: reasoningEffort(
      env,
      "PERSONAL_CONTEXT_VOICE_OBSERVER_REASONING_EFFORT",
      codexReasoningEffort ?? "low",
    ),
    taskModel,
    taskReasoningEffort,
    complexTaskModel: automaticVoiceModel(
      env.PERSONAL_CONTEXT_VOICE_COMPLEX_TASK_MODEL?.trim() || taskModel,
    ),
    complexTaskReasoningEffort: reasoningEffort(
      env,
      "PERSONAL_CONTEXT_VOICE_COMPLEX_TASK_REASONING_EFFORT",
      taskReasoningEffort,
    ),
    codexAgents,
    peerReviewEnabled: boolean(
      env,
      "PERSONAL_CONTEXT_VOICE_AGENT_PEER_REVIEW",
      codexAgents.length > 1,
    ),
    immediateReactions: boolean(
      env,
      "PERSONAL_CONTEXT_VOICE_IMMEDIATE_REACTIONS",
      true,
    ),
    messageContentIntent: boolean(
      env,
      "PERSONAL_CONTEXT_VOICE_MESSAGE_CONTENT_INTENT",
      true,
    ),
    quickReplyModel:
      env.PERSONAL_CONTEXT_VOICE_QUICK_REPLY_MODEL?.trim() || "gpt-4.1-mini",
    silentMessages: boolean(
      env,
      "PERSONAL_CONTEXT_VOICE_SILENT_MESSAGES",
      true,
    ),
    workingDirectory,
    statePath,
    transcriptArchiveDirectory:
      env.PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_DIR?.trim()
        ? absolutePath(
            env.PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_DIR,
            "PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_DIR",
          )
        : join(dirname(statePath), "discord-voice-transcripts"),
    transcriptArchiveDiscord: boolean(
      env,
      "PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_DISCORD",
      true,
    ),
    transcriptArchiveFlushIntervalMs: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_FLUSH_INTERVAL_MS",
      60_000,
      10_000,
      3_600_000,
    ),
    sttModel: env.PERSONAL_CONTEXT_VOICE_STT_MODEL?.trim() || "gpt-transcribe",
    ttsModel: env.PERSONAL_CONTEXT_VOICE_TTS_MODEL?.trim() || "gpt-4o-mini-tts",
    ttsVoice: env.PERSONAL_CONTEXT_VOICE_TTS_VOICE?.trim() || "marin",
    ttsSpeed: number(env, "PERSONAL_CONTEXT_VOICE_TTS_SPEED", 1, 0.25, 4),
    codexModel,
    codexReasoningEffort,
    codexTransport: (() => {
      const transport =
        env.PERSONAL_CONTEXT_VOICE_CODEX_TRANSPORT?.trim() || "app-server";
      if (!["app-server", "sdk"].includes(transport))
        throw new Error(
          "PERSONAL_CONTEXT_VOICE_CODEX_TRANSPORT must be app-server or sdk.",
        );
      return transport;
    })(),
    codexExecutable:
      env.PERSONAL_CONTEXT_VOICE_CODEX_EXECUTABLE?.trim() || undefined,
    codexHome: env.PERSONAL_CONTEXT_VOICE_CODEX_HOME?.trim()
      ? absolutePath(
          env.PERSONAL_CONTEXT_VOICE_CODEX_HOME,
          "PERSONAL_CONTEXT_VOICE_CODEX_HOME",
        )
      : undefined,
    isolatedCodexHome,
    codexSandbox,
    silenceMs: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_SILENCE_MS",
      1_000,
      300,
      5_000,
    ),
    speechStartSilenceMs: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_SPEECH_START_SILENCE_MS",
      1_000,
      0,
      5_000,
    ),
    minimumAudioMs: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_MINIMUM_AUDIO_MS",
      250,
      100,
      5_000,
    ),
    maximumAudioSeconds: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_MAXIMUM_AUDIO_SECONDS",
      90,
      5,
      300,
    ),
    maximumQueuedTurns: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_MAXIMUM_QUEUE",
      3,
      1,
      10,
    ),
    maximumPendingTranscriptions: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_MAXIMUM_PENDING_TRANSCRIPTIONS",
      60,
      1,
      100,
    ),
    maximumPendingTasks: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_MAXIMUM_PENDING_TASKS",
      10,
      1,
      50,
    ),
    taskConcurrency,
    transcriptionConcurrency: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_TRANSCRIPTION_CONCURRENCY",
      4,
      1,
      8,
    ),
    observationIntervalMs: integer(
      env,
      "PERSONAL_CONTEXT_VOICE_OBSERVATION_INTERVAL_MS",
      60_000,
      5_000,
      600_000,
    ),
    stageTimeouts: {
      transcribing: integer(
        env,
        "PERSONAL_CONTEXT_VOICE_STT_TIMEOUT_MS",
        120_000,
        5_000,
        600_000,
      ),
      running_codex: codexTimeoutMs,
      observing: integer(
        env,
        "PERSONAL_CONTEXT_VOICE_OBSERVER_TIMEOUT_MS",
        Math.min(codexTimeoutMs, 60_000),
        5_000,
        300_000,
      ),
      posting: integer(
        env,
        "PERSONAL_CONTEXT_VOICE_DISCORD_TIMEOUT_MS",
        30_000,
        5_000,
        120_000,
      ),
      synthesizing: integer(
        env,
        "PERSONAL_CONTEXT_VOICE_TTS_TIMEOUT_MS",
        120_000,
        5_000,
        600_000,
      ),
      speaking: integer(
        env,
        "PERSONAL_CONTEXT_VOICE_PLAYBACK_TIMEOUT_MS",
        300_000,
        10_000,
        900_000,
      ),
    },
    openaiApiKey: required(env, "OPENAI_API_KEY"),
  };
}

export function describeDiscordVoiceConfig(config) {
  return {
    guildId: config.guildId,
    voiceChannelId: config.voiceChannelId,
    textChannelId: config.textChannelId,
    issueForumChannelId: config.issueForumChannelId,
    agentCoordinationChannelId: config.agentCoordinationChannelId,
    workerGatewayEnabled: config.workerGatewayEnabled,
    workerGatewayHost: config.workerGatewayHost,
    workerGatewayPort: config.workerGatewayPort,
    workerGatewayPublicUrl: config.workerGatewayPublicUrl,
    workerPairingTtlMs: config.workerPairingTtlMs,
    workerHeartbeatTimeoutMs: config.workerHeartbeatTimeoutMs,
    workerLeaseTtlMs: config.workerLeaseTtlMs,
    agentWebhookAvatars: config.agentWebhookAvatars,
    allowedUserId: config.allowedUserId,
    listenToEveryone: config.listenToEveryone,
    powerMode: config.powerMode,
    voiceMode: config.voiceMode,
    liveEnabled: config.liveEnabled,
    previewConfigured: Boolean(config.previewCommand),
    previewBrowserChecks: config.previewChecks?.length ?? 0,
    previewSharingConfigured: Boolean(config.previewSharedUrlTemplate),
    operatorUserCount: config.operatorUserIds?.length ?? 0,
    requireWakeWord: config.requireWakeWord,
    immediateReactions: config.immediateReactions,
    allParticipantsOperate: config.allParticipantsOperate,
    autonomousTasks: config.autonomousTasks,
    answerUnaddressedQuestions: config.answerUnaddressedQuestions,
    quickReplyModel: config.quickReplyModel,
    messageContentIntent: config.messageContentIntent,
    silentMessages: config.silentMessages,
    workingDirectory: config.workingDirectory,
    statePath: config.statePath,
    transcriptArchiveDirectory: config.transcriptArchiveDirectory,
    transcriptArchiveDiscord: config.transcriptArchiveDiscord,
    transcriptArchiveFlushIntervalMs: config.transcriptArchiveFlushIntervalMs,
    sttModel: config.sttModel,
    ttsModel: config.ttsModel,
    ttsVoice: config.ttsVoice,
    ttsSpeed: config.ttsSpeed,
    speechStartSilenceMs: config.speechStartSilenceMs,
    maximumPendingTranscriptions: config.maximumPendingTranscriptions,
    maximumPendingTasks: config.maximumPendingTasks,
    taskConcurrency: config.taskConcurrency,
    codexAgents: (config.codexAgents ?? []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      capabilities: agent.capabilities,
      maximumConcurrentTasks: agent.maximumConcurrentTasks,
      workingDirectory: agent.workingDirectory,
      channelId: agent.channelId,
      model: agent.model ?? "Codex configured default",
      reasoningEffort: agent.reasoningEffort,
    })),
    peerReviewEnabled: config.peerReviewEnabled,
    transcriptionConcurrency: config.transcriptionConcurrency,
    observationIntervalMs: config.observationIntervalMs,
    codexModel: config.codexModel ?? "Codex configured default",
    codexReasoningEffort:
      config.codexReasoningEffort ?? "Codex configured default",
    observer: {
      model: config.observerModel,
      reasoningEffort: config.observerReasoningEffort,
    },
    task: {
      model: config.taskModel,
      reasoningEffort: config.taskReasoningEffort,
    },
    complexTask: {
      model: config.complexTaskModel,
      reasoningEffort: config.complexTaskReasoningEffort,
    },
    codexHomeConfigured: Boolean(config.codexHome),
    codexTransport: config.codexTransport,
    astraPolicy: "explicit-task-only",
    isolatedCodexHomeConfigured: Boolean(config.isolatedCodexHome),
    codexSandbox: config.codexSandbox,
    stageTimeouts: config.stageTimeouts,
    openaiApiKeyConfigured: Boolean(config.openaiApiKey),
  };
}
