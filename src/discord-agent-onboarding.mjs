import { validateWorkerGatewayConfig } from "./discord-agent-worker-gateway.mjs";

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

export function agentGuideComponents(guideUrl) {
  if (!guideUrl) return [];
  const url = new URL(guideUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.hash)
    throw new Error(
      "Agent guide must use an HTTPS URL without credentials or fragments.",
    );
  return [
    {
      type: 1,
      components: [
        { type: 2, style: 5, label: "参加・ログイン手順を開く", url: url.href },
      ],
    },
  ];
}
