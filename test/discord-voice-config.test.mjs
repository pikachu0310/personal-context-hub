import assert from "node:assert/strict";
import test from "node:test";
import {
  describeDiscordVoiceConfig,
  loadDiscordVoiceConfig,
} from "../src/discord-voice-config.mjs";
import { selectTaskProfile } from "../src/discord-voice-workspace.mjs";

const valid = {
  PERSONAL_CONTEXT_VOICE_GUILD_ID: "11111111111111111",
  PERSONAL_CONTEXT_VOICE_CHANNEL_ID: "22222222222222222",
  PERSONAL_CONTEXT_VOICE_TEXT_CHANNEL_ID: "33333333333333333",
  PERSONAL_CONTEXT_VOICE_USER_ID: "44444444444444444",
  PERSONAL_CONTEXT_VOICE_WORKDIR: "/tmp/voice-workspace",
  PERSONAL_CONTEXT_VOICE_CODEX_HOME: "/mnt/c/Users/example/.codex",
  OPENAI_API_KEY: "test-secret-never-print",
};

test("speech-start silence defaults to one second and is independent of recording silence", () => {
  const config = loadDiscordVoiceConfig(valid);
  assert.equal(config.speechStartSilenceMs, 1_000);
  assert.equal(describeDiscordVoiceConfig(config).speechStartSilenceMs, 1_000);
  for (const silence of [0, 750, 5_000]) {
    const configured = loadDiscordVoiceConfig({
      ...valid,
      PERSONAL_CONTEXT_VOICE_SILENCE_MS: "1500",
      PERSONAL_CONTEXT_VOICE_SPEECH_START_SILENCE_MS: String(silence),
    });
    assert.equal(configured.speechStartSilenceMs, silence);
    assert.equal(configured.silenceMs, 1_500);
    assert.equal(
      describeDiscordVoiceConfig(configured).speechStartSilenceMs,
      silence,
    );
  }
});

test("speech-start silence rejects invalid delays", () => {
  for (const silence of ["-1", "5001", "0.5", "invalid"]) {
    assert.throws(
      () =>
        loadDiscordVoiceConfig({
          ...valid,
          PERSONAL_CONTEXT_VOICE_SPEECH_START_SILENCE_MS: silence,
        }),
      /PERSONAL_CONTEXT_VOICE_SPEECH_START_SILENCE_MS must be an integer from 0 through 5000/,
    );
  }
});

test("automatic routing cannot inherit Astra from an old shared or complex profile", () => {
  const shared = loadDiscordVoiceConfig({
    ...valid,
    PERSONAL_CONTEXT_VOICE_CODEX_MODEL: "gpt-6-astra",
    PERSONAL_CONTEXT_VOICE_CODEX_REASONING_EFFORT: "high",
  });
  assert.equal(shared.observerModel, "gpt-5.6-sol");
  assert.equal(shared.observerReasoningEffort, "high");
  assert.equal(
    selectTaskProfile({ complexity: "routine" }, shared).model,
    "gpt-5.6-sol",
  );
  assert.equal(
    selectTaskProfile({ complexity: "complex" }, shared).modelReasoningEffort,
    "high",
  );
  const split = loadDiscordVoiceConfig({
    ...valid,
    PERSONAL_CONTEXT_VOICE_CODEX_MODEL: "gpt-6-astra",
    PERSONAL_CONTEXT_VOICE_CODEX_REASONING_EFFORT: "high",
    PERSONAL_CONTEXT_VOICE_OBSERVER_MODEL: "gpt-5.6-sol",
    PERSONAL_CONTEXT_VOICE_OBSERVER_REASONING_EFFORT: "low",
    PERSONAL_CONTEXT_VOICE_TASK_MODEL: "gpt-5.6-sol",
    PERSONAL_CONTEXT_VOICE_TASK_REASONING_EFFORT: "medium",
    PERSONAL_CONTEXT_VOICE_COMPLEX_TASK_MODEL: "gpt-6-astra",
    PERSONAL_CONTEXT_VOICE_COMPLEX_TASK_REASONING_EFFORT: "high",
  });
  assert.equal(split.observerReasoningEffort, "low");
  assert.equal(
    selectTaskProfile({ complexity: "routine" }, split).model,
    "gpt-5.6-sol",
  );
  assert.equal(
    selectTaskProfile({ complexity: "routine" }, split).modelReasoningEffort,
    "medium",
  );
  assert.equal(
    selectTaskProfile({ complexity: "complex" }, split).model,
    "gpt-5.6-sol",
  );
  const effective = describeDiscordVoiceConfig(split);
  assert.deepEqual(effective.observer, {
    model: "gpt-5.6-sol",
    reasoningEffort: "low",
  });
  assert.deepEqual(effective.complexTask, {
    model: "gpt-5.6-sol",
    reasoningEffort: "high",
  });
  assert.doesNotMatch(JSON.stringify(effective), /test-secret-never-print/);
});

test("complex tasks inherit explicit worker settings and role reasoning values are validated", () => {
  const configured = loadDiscordVoiceConfig({
    ...valid,
    PERSONAL_CONTEXT_VOICE_TASK_MODEL: "gpt-6-astra",
    PERSONAL_CONTEXT_VOICE_TASK_REASONING_EFFORT: "high",
  });
  assert.equal(configured.complexTaskModel, "gpt-5.6-sol");
  assert.equal(configured.complexTaskReasoningEffort, "high");
  for (const role of ["OBSERVER", "TASK", "COMPLEX_TASK"])
    assert.throws(
      () =>
        loadDiscordVoiceConfig({
          ...valid,
          [`PERSONAL_CONTEXT_VOICE_${role}_REASONING_EFFORT`]: "invalid",
        }),
      /REASONING_EFFORT/,
    );
});

test("the conversation deadline can be configured independently and preserves a shorter legacy deadline", () => {
  const shorter = loadDiscordVoiceConfig({
    ...valid,
    PERSONAL_CONTEXT_VOICE_CODEX_TIMEOUT_MS: "30000",
  });
  assert.equal(shorter.stageTimeouts.observing, 30_000);
  const separate = loadDiscordVoiceConfig({
    ...valid,
    PERSONAL_CONTEXT_VOICE_CODEX_TIMEOUT_MS: "900000",
    PERSONAL_CONTEXT_VOICE_OBSERVER_TIMEOUT_MS: "15000",
  });
  assert.equal(separate.stageTimeouts.observing, 15_000);
  assert.equal(separate.stageTimeouts.running_codex, 900_000);
});

test("voice config loads a multi-agent Issue board without exposing secrets", () => {
  const config = loadDiscordVoiceConfig({
    ...valid,
    PERSONAL_CONTEXT_VOICE_ISSUE_FORUM_CHANNEL_ID: "55555555555555555",
    PERSONAL_CONTEXT_VOICE_AGENT_CHANNEL_ID: "66666666666666666",
    PERSONAL_CONTEXT_VOICE_CODEX_AGENTS: JSON.stringify([
      {
        id: "frontend",
        name: "Frontend Codex",
        capabilities: ["ui", "react"],
        maximumConcurrentTasks: 1,
        workingDirectory: valid.PERSONAL_CONTEXT_VOICE_WORKDIR,
        channelId: "77777777777777777",
      },
      {
        id: "backend",
        capabilities: ["api"],
        maximumConcurrentTasks: 1,
        workingDirectory: valid.PERSONAL_CONTEXT_VOICE_WORKDIR,
      },
    ]),
  });
  assert.equal(config.codexAgents.length, 2);
  assert.equal(config.peerReviewEnabled, true);
  assert.equal(config.issueForumChannelId, "55555555555555555");
  assert.equal(config.agentCoordinationChannelId, "66666666666666666");
  assert.equal(config.codexAgents[0].id, "frontend");
  assert.equal(config.codexAgents[0].channelId, "77777777777777777");
  const description = describeDiscordVoiceConfig(config);
  assert.equal(description.codexAgents.length, 2);
  assert.doesNotMatch(JSON.stringify(description), /test-secret-never-print/);
});

test("voice config validates Discord targets and redacts the OpenAI key", () => {
  const config = loadDiscordVoiceConfig(valid);
  assert.equal(config.silenceMs, 1_000);
  assert.equal(config.maximumAudioSeconds, 90);
  assert.equal(config.listenToEveryone, false);
  assert.equal(config.powerMode, false);
  assert.equal(config.voiceMode, "turn");
  assert.equal(config.immediateReactions, true);
  assert.equal(config.silentMessages, true);
  assert.equal(config.transcriptArchiveDiscord, true);
  assert.equal(config.transcriptArchiveFlushIntervalMs, 60_000);
  assert.match(
    config.transcriptArchiveDirectory,
    /personal-context-hub\/discord-voice-transcripts$/,
  );
  assert.equal(config.ttsSpeed, 1);
  assert.equal(config.observationIntervalMs, 60_000);
  assert.equal(config.transcriptionConcurrency, 4);
  assert.equal(config.maximumPendingTranscriptions, 60);
  assert.equal(config.maximumPendingTasks, 10);
  assert.equal(config.taskConcurrency, 2);
  assert.equal(config.codexHome, "/mnt/c/Users/example/.codex");
  assert.equal(config.codexReasoningEffort, "low");
  assert.match(
    config.isolatedCodexHome,
    /personal-context-hub\/discord-voice-codex-home$/,
  );
  assert.equal(config.stageTimeouts.running_codex, 900_000);
  assert.equal(config.stageTimeouts.observing, 60_000);
  const description = describeDiscordVoiceConfig(config);
  assert.equal(description.openaiApiKeyConfigured, true);
  assert.equal(description.codexHomeConfigured, true);
  assert.equal(description.isolatedCodexHomeConfigured, true);
  assert.equal(description.codexHome, undefined);
  assert.equal(description.isolatedCodexHome, undefined);
  assert.doesNotMatch(JSON.stringify(description), /test-secret/);
  assert.doesNotMatch(JSON.stringify(description), /\/mnt\/c\/Users/);
});

test("voice config accepts all-speaker mode and TTS speed", () => {
  const config = loadDiscordVoiceConfig({
    ...valid,
    PERSONAL_CONTEXT_VOICE_LISTEN_TO_EVERYONE: "true",
    PERSONAL_CONTEXT_VOICE_MODE: "meeting",
    PERSONAL_CONTEXT_VOICE_IMMEDIATE_REACTIONS: "false",
    PERSONAL_CONTEXT_VOICE_SILENT_MESSAGES: "false",
    PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_DISCORD: "false",
    PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_DIR: "/tmp/voice-transcripts",
    PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_FLUSH_INTERVAL_MS: "45000",
    PERSONAL_CONTEXT_VOICE_OBSERVATION_INTERVAL_MS: "45000",
    PERSONAL_CONTEXT_VOICE_TRANSCRIPTION_CONCURRENCY: "6",
    PERSONAL_CONTEXT_VOICE_MAXIMUM_PENDING_TRANSCRIPTIONS: "80",
    PERSONAL_CONTEXT_VOICE_POWER_MODE: "true",
    PERSONAL_CONTEXT_VOICE_CODEX_SANDBOX: "danger-full-access",
    PERSONAL_CONTEXT_VOICE_TASK_CONCURRENCY: "3",
    PERSONAL_CONTEXT_VOICE_MAXIMUM_PENDING_TASKS: "20",
    PERSONAL_CONTEXT_VOICE_TTS_SPEED: "2",
    PERSONAL_CONTEXT_VOICE_CODEX_MODEL: "gpt-5.6-sol",
    PERSONAL_CONTEXT_VOICE_CODEX_REASONING_EFFORT: "HIGH",
  });
  assert.equal(config.listenToEveryone, true);
  assert.equal(config.voiceMode, "meeting");
  assert.equal(config.immediateReactions, false);
  assert.equal(config.silentMessages, false);
  assert.equal(config.transcriptArchiveDiscord, false);
  assert.equal(config.transcriptArchiveDirectory, "/tmp/voice-transcripts");
  assert.equal(config.transcriptArchiveFlushIntervalMs, 45_000);
  assert.equal(config.ttsSpeed, 2);
  assert.equal(config.observationIntervalMs, 45_000);
  assert.equal(config.transcriptionConcurrency, 6);
  assert.equal(config.maximumPendingTranscriptions, 80);
  assert.equal(config.powerMode, true);
  assert.equal(config.codexSandbox, "danger-full-access");
  assert.equal(config.taskConcurrency, 3);
  assert.equal(config.maximumPendingTasks, 20);
  assert.equal(config.codexModel, "gpt-5.6-sol");
  assert.equal(config.codexReasoningEffort, "high");
  const description = describeDiscordVoiceConfig(config);
  assert.equal(description.listenToEveryone, true);
  assert.equal(description.voiceMode, "meeting");
  assert.equal(description.powerMode, true);
  assert.equal(description.silentMessages, false);
  assert.equal(description.transcriptArchiveDiscord, false);
  assert.equal(description.transcriptArchiveFlushIntervalMs, 45_000);
  assert.equal(description.ttsSpeed, 2);
  assert.equal(description.codexModel, "gpt-5.6-sol");
  assert.equal(description.codexReasoningEffort, "high");
});

test("voice config rejects missing and malformed trust-boundary IDs", () => {
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_MODE: "realtime-everything",
      }),
    /turn or meeting/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_LISTEN_TO_EVERYONE: "yes",
      }),
    /true or false/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_TTS_SPEED: "4.1",
      }),
    /from 0.25 through 4/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_USER_ID: "everyone",
      }),
    /snowflake/,
  );
  assert.throws(
    () => loadDiscordVoiceConfig({ ...valid, OPENAI_API_KEY: "" }),
    /OPENAI_API_KEY/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_MAXIMUM_QUEUE: "99",
      }),
    /from 1 through 10/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_CODEX_SANDBOX: "trust-me",
      }),
    /workspace-write/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_CODEX_SANDBOX: "danger-full-access",
      }),
    /power mode explicitly enables danger-full-access/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_CODEX_REASONING_EFFORT: "heroic",
      }),
    /minimal, low, medium, high, xhigh, max, or ultra/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_POWER_MODE: "yes",
      }),
    /true or false/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_WORKDIR: "relative/project",
      }),
    /absolute path/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_CODEX_HOME: "relative/.codex",
      }),
    /absolute path/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME: "relative/isolated",
      }),
    /absolute path/,
  );
  assert.throws(
    () =>
      loadDiscordVoiceConfig({
        ...valid,
        PERSONAL_CONTEXT_VOICE_STT_TIMEOUT_MS: "4999",
      }),
    /from 5000 through 600000/,
  );
});

test("voice config keeps the isolated Codex home beside an overridden state file", () => {
  const config = loadDiscordVoiceConfig({
    ...valid,
    PERSONAL_CONTEXT_VOICE_STATE_PATH: "/tmp/voice-state/thread.json",
  });
  assert.equal(
    config.isolatedCodexHome,
    "/tmp/voice-state/discord-voice-codex-home",
  );

  const explicit = loadDiscordVoiceConfig({
    ...valid,
    PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME: "/tmp/voice-codex-home",
  });
  assert.equal(explicit.isolatedCodexHome, "/tmp/voice-codex-home");
});

test("voice config exposes only public Worker gateway settings", () => {
  const config = loadDiscordVoiceConfig({
    ...valid,
    PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_ENABLED: "true",
    PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_HOST: "127.0.0.1",
    PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_PORT: "8788",
    PERSONAL_CONTEXT_VOICE_WORKER_GATEWAY_PUBLIC_URL:
      "wss://agents.example.test",
    PERSONAL_CONTEXT_VOICE_AGENT_WEBHOOK_AVATARS: "true",
  });
  assert.equal(config.workerGatewayEnabled, true);
  assert.equal(config.workerGatewayPort, 8788);
  assert.equal(config.workerGatewayPublicUrl, "wss://agents.example.test");
  assert.equal(config.agentWebhookAvatars, true);
  const described = describeDiscordVoiceConfig(config);
  assert.equal(described.workerGatewayEnabled, true);
  assert.doesNotMatch(JSON.stringify(described), /test-secret-never-print/);
});
