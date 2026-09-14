import { validateWorkerGatewayConfig } from "./discord-agent-worker-gateway.mjs";
import { agentGuideComponents } from "./discord-agent-onboarding.mjs";

export function assertPublicWorkerPolicy(config) {
  if (!config.workerGatewayEnabled) return;
  const { url } = validateWorkerGatewayConfig({
    host: config.workerGatewayHost,
    port: config.workerGatewayPort,
    publicUrl: config.workerGatewayPublicUrl,
  });
  agentGuideComponents(
    config.agentJoinGuideUrl,
    undefined,
    config.agentDownloadUrl,
  );
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return;
  if (config.allParticipantsOperate)
    throw new Error(
      "Public Worker access requires explicit operator user IDs; disable ALL_PARTICIPANTS_OPERATE.",
    );
  if (!["workspace-write", "read-only"].includes(config.codexSandbox))
    throw new Error(
      "Public Worker access requires a sandboxed host Codex configuration.",
    );
  if (config.autonomousTasks)
    throw new Error(
      "Public Worker access requires explicit task requests; disable AUTONOMOUS_TASKS.",
    );
}
