import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { VoiceServiceError } from "../src/discord-voice-errors.mjs";
import { inspectDiscordVoiceReadiness } from "../src/discord-voice-diagnostics.mjs";

const publicEnvironment = Object.freeze({
  PERSONAL_CONTEXT_VOICE_GUILD_ID: "11111111111111111",
  PERSONAL_CONTEXT_VOICE_CHANNEL_ID: "22222222222222222",
  PERSONAL_CONTEXT_VOICE_TEXT_CHANNEL_ID: "33333333333333333",
  PERSONAL_CONTEXT_VOICE_USER_ID: "44444444444444444",
  PERSONAL_CONTEXT_VOICE_WORKDIR: "/tmp/voice-workspace",
});

function directoryStat() {
  return { isDirectory: () => true };
}

test("readiness rejects invalid meeting and task settings instead of silently using defaults", async () => {
  for (const [field, value] of [
    ["PERSONAL_CONTEXT_VOICE_OPERATOR_IDS", "invalid-operator"],
    ["PERSONAL_CONTEXT_VOICE_REQUIRE_WAKE_WORD", "invalid-boolean"],
    ["PERSONAL_CONTEXT_VOICE_IMMEDIATE_REACTIONS", "invalid-boolean"],
    ["PERSONAL_CONTEXT_VOICE_SILENT_MESSAGES", "invalid-boolean"],
    ["PERSONAL_CONTEXT_VOICE_OBSERVER_REASONING_EFFORT", "invalid-effort"],
    ["PERSONAL_CONTEXT_VOICE_TASK_REASONING_EFFORT", "invalid-effort"],
    ["PERSONAL_CONTEXT_VOICE_COMPLEX_TASK_REASONING_EFFORT", "invalid-effort"],
    ["PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_DIR", "relative/path"],
    ["PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_DISCORD", "invalid-boolean"],
    ["PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_FLUSH_INTERVAL_MS", "1"],
  ]) {
    const report = await inspectDiscordVoiceReadiness({
      mode: "offline",
      env: { ...publicEnvironment, [field]: value },
      statPath: async () => directoryStat(),
    });
    assert.equal(report.ready, false, field);
    assert.equal(report.checks.configuration, "failed", field);
    assert.equal(report.issues[0].field, field);
  }
});

test("offline readiness validates public configuration without reading secrets", async () => {
  let credentialReads = 0;
  let codexPreparations = 0;
  const report = await inspectDiscordVoiceReadiness({
    mode: "offline",
    env: {
      ...publicEnvironment,
      OPENAI_API_KEY: "must-not-be-observed",
      PERSONAL_CONTEXT_VOICE_OPERATOR_IDS:
        "55555555555555555,66666666666666666",
      PERSONAL_CONTEXT_VOICE_REQUIRE_WAKE_WORD: "false",
      PERSONAL_CONTEXT_VOICE_IMMEDIATE_REACTIONS: "false",
      PERSONAL_CONTEXT_VOICE_SILENT_MESSAGES: "false",
      PERSONAL_CONTEXT_VOICE_OBSERVER_MODEL: "custom-observer",
      PERSONAL_CONTEXT_VOICE_OBSERVER_REASONING_EFFORT: "minimal",
      PERSONAL_CONTEXT_VOICE_TASK_MODEL: "custom-worker",
      PERSONAL_CONTEXT_VOICE_TASK_REASONING_EFFORT: "high",
      PERSONAL_CONTEXT_VOICE_COMPLEX_TASK_MODEL: "custom-complex-worker",
      PERSONAL_CONTEXT_VOICE_COMPLEX_TASK_REASONING_EFFORT: "xhigh",
      PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_DIR:
        "/tmp/custom-transcript-archive",
      PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_DISCORD: "false",
      PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_FLUSH_INTERVAL_MS: "12000",
    },
    readCredential: async () => {
      credentialReads += 1;
      throw new Error("must not run");
    },
    statPath: async () => directoryStat(),
    prepareCodex: async () => {
      codexPreparations += 1;
      throw new Error("must not run");
    },
  });

  assert.equal(credentialReads, 0);
  assert.equal(codexPreparations, 0);
  assert.equal(report.mode, "offline");
  assert.equal(report.ready, true);
  assert.equal(report.serviceReady, false);
  assert.deepEqual(report.checks, {
    botCredential: "skipped",
    openaiApiKey: "skipped",
    configuration: "passed",
    workingDirectory: "passed",
    codexIsolation: "skipped",
  });
  assert.equal(report.config.openaiApiKeyConfigured, false);
  assert.equal(report.config.operatorUserCount, 2);
  assert.equal(report.config.requireWakeWord, false);
  assert.equal(report.config.immediateReactions, false);
  assert.equal(report.config.silentMessages, false);
  assert.deepEqual(report.config.observer, {
    model: "custom-observer",
    reasoningEffort: "minimal",
  });
  assert.deepEqual(report.config.task, {
    model: "custom-worker",
    reasoningEffort: "high",
  });
  assert.deepEqual(report.config.complexTask, {
    model: "custom-complex-worker",
    reasoningEffort: "xhigh",
  });
  assert.equal(
    report.config.transcriptArchiveDirectory,
    "/tmp/custom-transcript-archive",
  );
  assert.equal(report.config.transcriptArchiveDiscord, false);
  assert.equal(report.config.transcriptArchiveFlushIntervalMs, 12000);
  assert.deepEqual(report.issues, []);
  assert.doesNotMatch(JSON.stringify(report), /must-not-be-observed/);
});

test("full readiness checks every boundary without returning credentials", async () => {
  const report = await inspectDiscordVoiceReadiness({
    mode: "full",
    env: {
      ...publicEnvironment,
      OPENAI_API_KEY: "openai-secret-never-print",
    },
    readCredential: async () => ({
      token: "discord-secret-never-print",
      applicationId: "55555555555555555",
      botUserId: "66666666666666666",
    }),
    statPath: async () => directoryStat(),
    prepareCodex: async () => undefined,
  });

  assert.equal(report.mode, "full");
  assert.equal(report.ready, true);
  assert.equal(report.serviceReady, true);
  assert.ok(
    Object.values(report.checks).every((status) => status === "passed"),
  );
  assert.deepEqual(report.issues, []);
  assert.doesNotMatch(
    JSON.stringify(report),
    /openai-secret-never-print|discord-secret-never-print/,
  );
});

test("diagnostics aggregate stable remediation codes without raw errors", async () => {
  const report = await inspectDiscordVoiceReadiness({
    mode: "full",
    env: {
      ...publicEnvironment,
      OPENAI_API_KEY: "openai-private-value",
    },
    readCredential: async () => {
      throw new Error("credential store leaked discord-private-value");
    },
    statPath: async () => {
      throw new Error("workdir leaked workstation-private-value");
    },
    prepareCodex: async () => {
      throw new VoiceServiceError(
        "CODEX_HOME_INVALID",
        "isolation leaked codex-private-value",
        "public detail must not be reused here",
      );
    },
  });

  assert.equal(report.ready, false);
  assert.equal(report.serviceReady, false);
  assert.deepEqual(
    report.issues.map(({ code }) => code),
    [
      "BOT_CREDENTIAL_MISSING",
      "WORKING_DIRECTORY_UNAVAILABLE",
      "CODEX_ISOLATION_UNAVAILABLE",
    ],
  );
  assert.equal(report.issues[2].causeCode, "CODEX_HOME_INVALID");
  for (const issue of report.issues) {
    assert.match(issue.code, /^[A-Z][A-Z0-9_]+$/);
    assert.ok(issue.message.length > 0);
    assert.ok(issue.action.length > 0);
  }
  assert.doesNotMatch(
    JSON.stringify(report),
    /private-value|credential store leaked|public detail must not be reused/,
  );
});

test("missing and invalid public settings are reported without exception text", async () => {
  const missing = await inspectDiscordVoiceReadiness({
    mode: "offline",
    env: {},
    statPath: async () => directoryStat(),
  });
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.issues, [
    {
      code: "REQUIRED_ENVIRONMENT_MISSING",
      message: "必須の環境変数が設定されていません。",
      action: ".env.exampleを参照し、fieldsの環境変数を設定してください。",
      fields: [
        "PERSONAL_CONTEXT_VOICE_GUILD_ID",
        "PERSONAL_CONTEXT_VOICE_CHANNEL_ID",
        "PERSONAL_CONTEXT_VOICE_TEXT_CHANNEL_ID",
        "PERSONAL_CONTEXT_VOICE_USER_ID",
        "PERSONAL_CONTEXT_VOICE_WORKDIR",
      ],
    },
  ]);

  const invalid = await inspectDiscordVoiceReadiness({
    mode: "offline",
    env: {
      ...publicEnvironment,
      PERSONAL_CONTEXT_VOICE_USER_ID: "not-a-snowflake private-detail",
    },
    statPath: async () => directoryStat(),
  });
  assert.deepEqual(invalid.issues, [
    {
      code: "CONFIG_INVALID",
      message: "Discord音声設定に許容範囲外の値があります。",
      action: ".env.exampleとMVP仕様を参照して設定値を修正してください。",
      field: "PERSONAL_CONTEXT_VOICE_USER_ID",
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(invalid),
    /not-a-snowflake|private-detail/,
  );
});

test("diagnostic mode must be explicit", async () => {
  await assert.rejects(
    () => inspectDiscordVoiceReadiness({ mode: "network-ish" }),
    /mode must be offline or full/,
  );
});

test("offline CLI emits a credential-free JSON report", () => {
  const script = fileURLToPath(
    new URL("../scripts/inspect-discord-voice-config.mjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [script, "--offline"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      ...publicEnvironment,
      PERSONAL_CONTEXT_VOICE_WORKDIR: process.cwd(),
      OPENAI_API_KEY: "offline-cli-secret-never-print",
    },
  });

  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.serviceReady, false);
  assert.equal(report.checks.botCredential, "skipped");
  assert.equal(report.checks.codexIsolation, "skipped");
  assert.doesNotMatch(result.stdout, /offline-cli-secret-never-print/);
});
