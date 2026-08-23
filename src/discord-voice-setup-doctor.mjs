import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { inspectDiscordVoiceReadiness } from "./discord-voice-diagnostics.mjs";

export const VOICE_CODEX_DOCTOR_OK = "VOICE_CODEX_DOCTOR_OK";
export const VOICE_CODEX_DOCTOR_FAILED = "VOICE_CODEX_DOCTOR_FAILED";

const MINIMUM_NODE_MAJOR = 22;
const CHILD_RUNTIME_ENVIRONMENT = Object.freeze([
  "HOME",
  "PATH",
  "LANG",
  "LC_ALL",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
  "LOGNAME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
]);

const GUIDANCE = Object.freeze({
  NODE_RUNTIME_UNSUPPORTED: Object.freeze({
    message: "Node.js 22以上が必要です。",
    action:
      "node --versionを確認し、Node.js 22以上のWSL runtimeを使用してください。",
  }),
  OFFLINE_DIAGNOSTIC_FAILED: Object.freeze({
    message: "offline設定診断を完了できませんでした。",
    action:
      "inspect:discord:voice:offlineを単独実行し、表示されたcodeだけを確認してください。",
  }),
  MOCK_SMOKE_FAILED: Object.freeze({
    message: "mock音声縦断が成功しませんでした。",
    action:
      "smoke:discord:voice:mockを単独実行し、秘密を含めず失敗stageを確認してください。",
  }),
  CODEX_ISOLATION_SMOKE_FAILED: Object.freeze({
    message: "Codex隔離local smokeが成功しませんでした。",
    action:
      "smoke:discord:voice:localを実行し、auth.jsonと空configの条件を確認してください。",
  }),
});

function issue(code, detail = {}) {
  return { code, ...GUIDANCE[code], ...detail };
}

function safeDiagnosticIssues(issues) {
  return (Array.isArray(issues) ? issues : []).map((entry) => {
    const safe = {
      code: entry?.code ?? "UNEXPECTED_ERROR",
      message: entry?.message ?? "診断に失敗しました。",
      action: entry?.action ?? "診断ガイドの手順を確認してください。",
    };
    if (Array.isArray(entry?.fields)) safe.fields = entry.fields;
    if (typeof entry?.field === "string") safe.field = entry.field;
    if (typeof entry?.causeCode === "string") safe.causeCode = entry.causeCode;
    return safe;
  });
}

function nodeMajor(version) {
  const match = /^(\d+)/.exec(String(version ?? ""));
  return match ? Number(match[1]) : Number.NaN;
}

function childEnvironment() {
  return Object.fromEntries(
    CHILD_RUNTIME_ENVIRONMENT.filter(
      (name) => typeof process.env[name] === "string",
    ).map((name) => [name, process.env[name]]),
  );
}

function defaultSmokeRunner(scriptName, marker) {
  const scriptPath = fileURLToPath(
    new URL(`../scripts/${scriptName}`, import.meta.url),
  );
  return async () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: childEnvironment(),
      timeout: 30_000,
    });
    return {
      ok: result.status === 0 && result.stdout?.includes(marker),
      marker,
    };
  };
}

const defaultMockRunner = defaultSmokeRunner(
  "../test/discord-voice-mock-e2e.test.mjs",
  "VOICE_CODEX_MOCK_E2E_OK",
);
const defaultLocalRunner = defaultSmokeRunner(
  "discord-voice-local-smoke.mjs",
  "VOICE_CODEX_LOCAL_OK",
);

export async function runDiscordVoiceSetupDoctor({
  env = process.env,
  nodeVersion = process.versions.node,
  inspect = inspectDiscordVoiceReadiness,
  runMock = defaultMockRunner,
  runLocal = defaultLocalRunner,
} = {}) {
  const checks = {
    runtime: "pending",
    publicConfig: "pending",
    mockVertical: "pending",
    codexIsolation: "pending",
  };
  const issues = [];

  if (nodeMajor(nodeVersion) < MINIMUM_NODE_MAJOR) {
    checks.runtime = "failed";
    checks.publicConfig = "skipped";
    checks.mockVertical = "skipped";
    checks.codexIsolation = "skipped";
    issues.push(issue("NODE_RUNTIME_UNSUPPORTED"));
  } else {
    checks.runtime = "passed";
    try {
      const report = await inspect({ mode: "offline", env });
      checks.publicConfig = report?.ready ? "passed" : "failed";
      if (!report?.ready) issues.push(...safeDiagnosticIssues(report?.issues));
    } catch {
      checks.publicConfig = "failed";
      issues.push(issue("OFFLINE_DIAGNOSTIC_FAILED"));
    }

    try {
      const result = await runMock();
      checks.mockVertical =
        result?.ok && result.marker === "VOICE_CODEX_MOCK_E2E_OK"
          ? "passed"
          : "failed";
    } catch {
      checks.mockVertical = "failed";
    }
    if (checks.mockVertical === "failed") {
      issues.push(issue("MOCK_SMOKE_FAILED"));
    }

    try {
      const result = await runLocal();
      checks.codexIsolation =
        result?.ok && result.marker === "VOICE_CODEX_LOCAL_OK"
          ? "passed"
          : "failed";
    } catch {
      checks.codexIsolation = "failed";
    }
    if (checks.codexIsolation === "failed") {
      issues.push(issue("CODEX_ISOLATION_SMOKE_FAILED"));
    }
  }

  const ready = Object.values(checks).every((status) => status === "passed");
  return {
    version: 1,
    marker: ready ? VOICE_CODEX_DOCTOR_OK : VOICE_CODEX_DOCTOR_FAILED,
    ready,
    externalCalls: 0,
    checks,
    issues,
    commands: [
      "inspect:discord:voice:offline",
      "smoke:discord:voice:mock",
      "smoke:discord:voice:local",
    ],
    next: ready
      ? "実接続前checklistを確認し、資格情報を入力せずに不足項目を整理してください。"
      : "issuesのcodeに対応するローカル修正後、doctorを再実行してください。",
  };
}
