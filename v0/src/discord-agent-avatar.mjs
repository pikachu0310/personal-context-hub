import { createHash } from "node:crypto";
import sharp from "sharp";

const DISCORD_CDN_HOSTS = new Set([
  "cdn.discordapp.com",
  "media.discordapp.net",
]);

function colorFor(agentId) {
  const digest = createHash("sha256").update(String(agentId)).digest();
  return `hsl(${digest.readUInt16BE(0) % 360} 72% 52%)`;
}

function initials(value) {
  return String(value ?? "AI")
    .trim()
    .split(/\s+/)
    .map((part) => [...part][0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function safeAvatarUrl(value) {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" || !DISCORD_CDN_HOSTS.has(url.hostname))
    throw new Error("Agent owner avatar must use the Discord CDN.");
  url.search = "";
  return url;
}

export async function generateAgentAvatar(
  profile,
  { fetchImpl = fetch, image = sharp } = {},
) {
  const size = 256;
  const color = colorFor(profile.id);
  let background = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" rx="128" fill="${color}"/><text x="128" y="150" text-anchor="middle" font-size="76" font-family="sans-serif" font-weight="700" fill="white">${escapeXml(initials(profile.ownerDisplayName ?? profile.name))}</text></svg>`,
  );
  try {
    const url = safeAvatarUrl(profile.ownerAvatarUrl);
    if (url) {
      const response = await fetchImpl(url, {
        headers: { accept: "image/png,image/webp,image/jpeg" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("Discord avatar download failed.");
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length > 8 * 1024 * 1024)
        throw new Error("Discord avatar is too large.");
      background = await image(bytes)
        .resize(size, size, { fit: "cover" })
        .png()
        .toBuffer();
    }
  } catch {
    // A deterministic local fallback keeps agent identity available.
  }
  const badge = Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <circle cx="128" cy="128" r="119" fill="none" stroke="${color}" stroke-width="18"/>
      <circle cx="199" cy="199" r="46" fill="${color}" stroke="white" stroke-width="8"/>
      <rect x="172" y="178" width="54" height="43" rx="12" fill="white"/>
      <circle cx="188" cy="199" r="5" fill="${color}"/><circle cx="210" cy="199" r="5" fill="${color}"/>
      <path d="M199 178v-12m-7 0h14" stroke="white" stroke-width="7" stroke-linecap="round"/>
    </svg>`,
  );
  return image(background)
    .composite([{ input: badge }])
    .png()
    .toBuffer();
}

export class DiscordAgentWebhookPublisher {
  constructor({ issueForum, agentTeam, fetchImpl = fetch, image = sharp }) {
    this.issueForum = issueForum;
    this.agentTeam = agentTeam;
    this.fetchImpl = fetchImpl;
    this.image = image;
    this.webhooks = new Map();
    this.preparing = new Map();
  }

  async post(agentId, thread, content, { signal, issueId } = {}) {
    signal?.throwIfAborted();
    const profile = this.agentTeam?.get(agentId);
    if (!profile || !this.issueForum) return undefined;
    const webhook = await this.#ensure(profile);
    signal?.throwIfAborted();
    const decorated = [
      `Agent: ${profile.id} · Owner: ${
        profile.ownerUserId ? `<@${profile.ownerUserId}>` : "Bot host"
      }${issueId ? ` · Issue: ${issueId}` : ""}`,
      content,
    ].join("\n");
    return webhook.send({
      content: decorated,
      threadId: thread.id,
      username:
        `${profile.name} · ${profile.ownerDisplayName ?? "Codex"}`.slice(0, 80),
      allowedMentions: { parse: [] },
      flags: 4096,
    });
  }

  async #ensure(profile) {
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          profile.name,
          profile.ownerDisplayName,
          profile.ownerAvatarUrl,
        ]),
      )
      .digest("hex");
    const cached = this.webhooks.get(profile.id);
    if (cached?.fingerprint === fingerprint) return cached.webhook;
    await cached?.webhook
      ?.delete("Refresh the managed agent identity")
      .catch(() => undefined);
    this.webhooks.delete(profile.id);
    if (this.preparing.has(profile.id)) return this.preparing.get(profile.id);
    const operation = (async () => {
      const marker = `ido-agent-${profile.id}`.slice(0, 80);
      const existing = await this.issueForum
        .fetchWebhooks?.()
        .catch(() => undefined);
      const values = existing?.values ? [...existing.values()] : [];
      await Promise.allSettled(
        values
          .filter((webhook) => webhook.name === marker)
          .map((webhook) =>
            webhook.delete("Refresh the managed agent identity"),
          ),
      );
      const avatar = await generateAgentAvatar(profile, {
        fetchImpl: this.fetchImpl,
        image: this.image,
      });
      const webhook = await this.issueForum.createWebhook({
        name: marker,
        avatar,
        reason: `Create the managed Discord identity for Codex agent ${profile.id}`,
      });
      this.webhooks.set(profile.id, { webhook, fingerprint });
      return webhook;
    })().finally(() => this.preparing.delete(profile.id));
    this.preparing.set(profile.id, operation);
    return operation;
  }
}
