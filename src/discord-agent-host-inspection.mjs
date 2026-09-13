import { validateAgentEndpoint } from "./discord-agent-endpoint.mjs";
import { assertPublicWorkerPolicy } from "./discord-agent-public-policy.mjs";

// Inspect connection-related settings only. Never authenticate, start a Bot,
// open a port, launch a tunnel, or return input values (which can be secrets).
export function inspectAgentHost(env = {}) {
  const checks = [];
  const add = (code, passed, message) => checks.push({ code, passed, message });
  const read = (suffix) => env[`PERSONAL_CONTEXT_VOICE_${suffix}`]?.trim();
  const host = read("WORKER_GATEWAY_HOST") || "127.0.0.1";
  const port = Number(read("WORKER_GATEWAY_PORT") ?? 8787);
  add(
    "GATEWAY_ENABLED",
    read("WORKER_GATEWAY_ENABLED") === "true",
    "Worker Gatewayが有効",
  );
  add(
    "LOOPBACK_ONLY",
    ["127.0.0.1", "::1", "localhost"].includes(host),
    "待受先がこのPC内だけに限定されている",
  );
  add(
    "DEDICATED_PORT",
    Number.isInteger(port) && port > 0 && port <= 65535 && port !== 17879,
    "参加者の接続画面と異なる有効なポートを使う",
  );
  add(
    "EXPLICIT_OPERATORS",
    read("ALL_PARTICIPANTS_OPERATE") === "false",
    "Bot全体の操作を全参加者へ無条件に許可しない",
  );
  add(
    "EXPLICIT_TASKS",
    read("AUTONOMOUS_TASKS") === "false",
    "自律的なタスク作成が無効",
  );
  add(
    "HOST_SANDBOX",
    ["workspace-write", "read-only"].includes(read("CODEX_SANDBOX")),
    "ホストのCodexにサンドボックスを使用する",
  );
  const localConfigPassed = checks.every((check) => check.passed);
  let publicEndpointConfigured = false;
  try {
    const value = read("WORKER_GATEWAY_PUBLIC_URL");
    const { loopback } = validateAgentEndpoint(value);
    assertPublicWorkerPolicy({
      workerGatewayEnabled: true,
      workerGatewayHost: host,
      workerGatewayPort: port,
      workerGatewayPublicUrl: value,
      allParticipantsOperate: read("ALL_PARTICIPANTS_OPERATE") !== "false",
      autonomousTasks: read("AUTONOMOUS_TASKS") !== "false",
      codexSandbox: read("CODEX_SANDBOX"),
    });
    publicEndpointConfigured = !loopback;
  } catch {
    /* Report a fixed message, never the rejected URL or exception. */
  }
  add(
    "PUBLIC_WSS_CONFIGURED",
    publicEndpointConfigured,
    "有効な公開WSS接続先が設定されている（疎通確認とは別）",
  );
  return {
    version: 1,
    localConfigPassed,
    publicEndpointConfigured,
    externalReachability: "not_tested",
    authentication: "not_tested",
    externalCalls: 0,
    checks,
    next: !localConfigPassed
      ? "失敗したローカル設定を修正してください。秘密の値を共有する必要はありません。"
      : !publicEndpointConfigured
        ? "ローカルの接続設定を確認しました。公開WSS接続先は未設定です。"
        : "設定の検査は通りました。実際の公開範囲・TLS・2人の接続と登録解除は未検証です。",
  };
}

export function agentHostReportText(report) {
  return [
    "PCホストの接続設定チェック",
    "",
    ...report.checks.map(
      (check) => `${check.passed ? "OK" : "要確認"}  ${check.message}`,
    ),
    "",
    report.next,
    "",
    "Bot・トンネルは起動しません。外部通信・認証・設定変更は行いません。",
  ].join("\n");
}
