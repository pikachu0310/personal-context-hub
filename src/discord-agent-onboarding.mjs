import { validateWorkerGatewayConfig } from "./discord-agent-worker-gateway.mjs";

// This is each participant's loopback UI, never the central Bot gateway.
export const AGENT_UI_PORT = 17879;

export function agentInvitationUrl(pairing) {
  return `http://127.0.0.1:${AGENT_UI_PORT}/join#${encodeAgentInvitation(pairing)}`;
}

export function encodeAgentInvitation(pairing) {
  return `ido1.${Buffer.from(JSON.stringify({ gatewayUrl: pairing.gatewayUrl, code: pairing.code, expiresAt: pairing.expiresAt })).toString("base64url")}`;
}

export function decodeAgentInvitation(value, now = Date.now()) {
  if (
    typeof value !== "string" ||
    value.length > 4096 ||
    !/^ido1\.[A-Za-z0-9_-]+$/.test(value.trim())
  )
    throw new Error("Invalid invitation.");
  const data = JSON.parse(
    Buffer.from(value.trim().slice(5), "base64url").toString("utf8"),
  );
  validateWorkerGatewayConfig({
    host: "127.0.0.1",
    publicUrl: data.gatewayUrl,
  });
  if (
    !/^[A-Z0-9_-]{12}$/.test(data.code) ||
    !Number.isSafeInteger(data.expiresAt) ||
    data.expiresAt <= now
  )
    throw new Error("Invitation expired or invalid.");
  return { gatewayUrl: data.gatewayUrl, pairingCode: data.code };
}

export function agentGuideComponents(guideUrl, pairing) {
  const components = [];
  if (pairing) {
    const url = agentInvitationUrl(pairing);
    // Discord limits link buttons to 512 characters. Keep manual import as a
    // fallback for unusually long gateway URLs instead of failing the reply.
    if (url.length <= 512)
      components.push({
        type: 2,
        style: 5,
        label: "このPCの接続画面に自動入力",
        url,
      });
  }
  if (guideUrl) {
    const url = new URL(guideUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      throw new Error(
        "Agent guide must use an HTTPS URL without credentials or fragments.",
      );
    components.push({
      type: 2,
      style: 5,
      label: "参加・ログイン手順を開く",
      url: url.href,
    });
  }
  if (!components.length) return [];
  return [
    {
      type: 1,
      components,
    },
  ];
}
