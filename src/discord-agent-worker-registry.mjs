import {
  createHash,
  createPublicKey,
  randomBytes,
  timingSafeEqual,
  verify,
} from "node:crypto";

const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const CAPABILITY = /^(?:\*|[a-z0-9][a-z0-9_.-]{0,39})$/;

const digest = (value) =>
  createHash("sha256").update(String(value)).digest("base64url");

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map((entry) => String(entry).trim().toLowerCase())
        .filter((entry) => CAPABILITY.test(entry)),
    ),
  ].slice(0, 30);
}

function normalizePublicKey(value) {
  const pem = String(value ?? "").trim();
  if (pem.length < 80 || pem.length > 2_000)
    throw new Error("Worker public key is invalid.");
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Worker public key must be Ed25519.");
  return pem;
}

function persistedWorker(record) {
  return {
    agentId: record.agentId,
    name: record.name,
    ownerUserId: record.ownerUserId,
    ownerDisplayName: record.ownerDisplayName,
    ownerAvatarUrl: record.ownerAvatarUrl,
    capabilities: [...record.capabilities],
    maximumConcurrentTasks: record.maximumConcurrentTasks,
    publicKey: record.publicKey,
    tokenHash: record.tokenHash,
    pairedAt: record.pairedAt,
    revokedAt: record.revokedAt,
    lastSeenAt: record.lastSeenAt,
  };
}

export class AgentWorkerRegistry {
  constructor({ now = () => Date.now(), pairingTtlMs = 5 * 60_000 } = {}) {
    this.now = now;
    this.pairingTtlMs = pairingTtlMs;
    this.pairings = new Map();
    this.workers = new Map();
  }

  restore(records = []) {
    for (const record of records) {
      if (
        !record ||
        !DISCORD_SNOWFLAKE.test(String(record.ownerUserId ?? "")) ||
        record.agentId !== `member-${record.ownerUserId}` ||
        !record.publicKey ||
        !record.tokenHash
      )
        continue;
      try {
        this.workers.set(record.agentId, {
          ...record,
          publicKey: normalizePublicKey(record.publicKey),
          capabilities: normalizeCapabilities(record.capabilities),
          maximumConcurrentTasks: Math.max(
            1,
            Math.min(4, Number(record.maximumConcurrentTasks) || 1),
          ),
          online: false,
          activeTasks: 0,
        });
      } catch {
        // Invalid persisted worker records fail closed and are ignored.
      }
    }
  }

  snapshot() {
    return [...this.workers.values()].map(persistedWorker);
  }

  createPairing({ ownerUserId, ownerDisplayName, ownerAvatarUrl }) {
    const userId = String(ownerUserId ?? "");
    if (!DISCORD_SNOWFLAKE.test(userId))
      throw new Error("A Discord user id is required for pairing.");
    for (const [key, pairing] of this.pairings)
      if (pairing.expiresAt < this.now() || pairing.ownerUserId === userId)
        this.pairings.delete(key);
    const code = randomBytes(9).toString("base64url").toUpperCase();
    if (this.pairings.size >= 1024)
      throw new Error(
        "Too many pending worker registrations. Try again later.",
      );
    const expiresAt = this.now() + this.pairingTtlMs;
    this.pairings.set(digest(code), {
      ownerUserId: userId,
      ownerDisplayName: String(ownerDisplayName ?? "Discord member")
        .trim()
        .slice(0, 80),
      ownerAvatarUrl: String(ownerAvatarUrl ?? "")
        .trim()
        .slice(0, 2_048),
      expiresAt,
    });
    return { code, expiresAt };
  }

  completePairing({
    code,
    publicKey,
    signature,
    challenge,
    capabilities,
    maximumConcurrentTasks = 1,
    name,
  }) {
    const pairingKey = digest(
      String(code ?? "")
        .trim()
        .toUpperCase(),
    );
    const pairing = this.pairings.get(pairingKey);
    this.pairings.delete(pairingKey);
    if (!pairing || pairing.expiresAt < this.now())
      throw new Error("Pairing code is invalid or expired.");
    const normalizedKey = normalizePublicKey(publicKey);
    const validSignature = verify(
      null,
      Buffer.from(String(challenge ?? "")),
      normalizedKey,
      Buffer.from(String(signature ?? ""), "base64url"),
    );
    if (!validSignature)
      throw new Error("Worker pairing signature is invalid.");
    const concurrent = Number(maximumConcurrentTasks);
    if (!Number.isInteger(concurrent) || concurrent < 1 || concurrent > 4)
      throw new Error("Worker concurrency must be from 1 through 4.");
    const agentId = `member-${pairing.ownerUserId}`;
    const token = randomBytes(32).toString("base64url");
    const requestedName = String(name ?? "")
      .trim()
      .slice(0, 80);
    const record = {
      agentId,
      name: requestedName || `${pairing.ownerDisplayName} Codex`.slice(0, 80),
      ownerUserId: pairing.ownerUserId,
      ownerDisplayName: pairing.ownerDisplayName,
      ownerAvatarUrl: pairing.ownerAvatarUrl,
      capabilities: normalizeCapabilities(capabilities),
      maximumConcurrentTasks: concurrent,
      publicKey: normalizedKey,
      tokenHash: digest(token),
      pairedAt: this.now(),
      lastSeenAt: this.now(),
      online: true,
      activeTasks: 0,
    };
    this.workers.set(agentId, record);
    return { agentId, token, worker: this.describe(agentId) };
  }

  authenticate({ agentId, token, challenge, signature }) {
    const record = this.workers.get(String(agentId ?? ""));
    if (!record || record.revokedAt) return false;
    try {
      if (!constantTimeEqual(record.tokenHash, digest(token))) return false;
      return verify(
        null,
        Buffer.from(String(challenge ?? "")),
        record.publicKey,
        Buffer.from(String(signature ?? ""), "base64url"),
      );
    } catch {
      return false;
    }
  }

  markOnline(agentId, online) {
    const record = this.workers.get(agentId);
    if (!record || record.revokedAt) return undefined;
    record.online = Boolean(online);
    record.lastSeenAt = this.now();
    return this.describe(agentId);
  }

  heartbeat(agentId) {
    return this.markOnline(agentId, true);
  }

  revokeOwner(ownerUserId) {
    const revoked = [];
    for (const record of this.workers.values()) {
      if (record.ownerUserId !== String(ownerUserId) || record.revokedAt)
        continue;
      record.revokedAt = this.now();
      record.online = false;
      revoked.push(record.agentId);
    }
    return revoked;
  }

  byOwner(ownerUserId) {
    return [...this.workers.values()]
      .filter(
        (record) =>
          record.ownerUserId === String(ownerUserId) && !record.revokedAt,
      )
      .map((record) => this.describe(record.agentId));
  }

  describe(agentId) {
    const record = this.workers.get(agentId);
    if (!record || record.revokedAt) return undefined;
    return {
      agentId: record.agentId,
      id: record.agentId,
      name: record.name,
      ownerUserId: record.ownerUserId,
      ownerDisplayName: record.ownerDisplayName,
      ownerAvatarUrl: record.ownerAvatarUrl,
      capabilities: [...record.capabilities],
      maximumConcurrentTasks: record.maximumConcurrentTasks,
      pairedAt: record.pairedAt,
      lastSeenAt: record.lastSeenAt,
      online: Boolean(record.online),
      transport: "remote",
      enabled: true,
    };
  }
}
