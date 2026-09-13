import { isAbsolute, resolve } from "node:path";

const AGENT_ID = /^[a-z][a-z0-9_-]{0,39}$/;
const DISCORD_SNOWFLAKE = /^\d{17,20}$/;
const REASONING_EFFORTS = new Set([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
]);
const ACTIVE_STATES = new Set(["queued", "running", "awaiting_receipt"]);

function optionalSnowflake(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return undefined;
  if (!DISCORD_SNOWFLAKE.test(normalized))
    throw new Error(`${label} must be a Discord snowflake.`);
  return normalized;
}

function normalizeCapabilities(value) {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.map((entry) => String(entry).trim().toLowerCase()).filter(Boolean),
    ),
  ].slice(0, 30);
}

function normalizeAgent(agent, index, defaults) {
  if (!agent || typeof agent !== "object" || Array.isArray(agent))
    throw new Error(`Codex agent at index ${index} must be an object.`);
  const id = String(agent.id ?? "")
    .trim()
    .toLowerCase();
  if (!AGENT_ID.test(id))
    throw new Error(
      `Codex agent id at index ${index} must match ${AGENT_ID.source}.`,
    );
  const name = String(agent.name ?? id).trim();
  if (!name || name.length > 80)
    throw new Error(`Codex agent ${id} must have a name up to 80 characters.`);
  const workingDirectory = agent.workingDirectory
    ? String(agent.workingDirectory).trim()
    : defaults.workingDirectory;
  if (!workingDirectory || !isAbsolute(workingDirectory))
    throw new Error(`Codex agent ${id} workingDirectory must be absolute.`);
  const maximumConcurrentTasks = Number(agent.maximumConcurrentTasks ?? 1);
  if (
    !Number.isInteger(maximumConcurrentTasks) ||
    maximumConcurrentTasks < 1 ||
    maximumConcurrentTasks > 4
  )
    throw new Error(
      `Codex agent ${id} maximumConcurrentTasks must be an integer from 1 through 4.`,
    );
  const reasoningEffort = String(
    agent.reasoningEffort ?? defaults.reasoningEffort ?? "medium",
  )
    .trim()
    .toLowerCase();
  if (!REASONING_EFFORTS.has(reasoningEffort))
    throw new Error(`Codex agent ${id} has an invalid reasoningEffort.`);
  return Object.freeze({
    id,
    name,
    capabilities: normalizeCapabilities(agent.capabilities),
    maximumConcurrentTasks,
    workingDirectory: resolve(workingDirectory),
    channelId: optionalSnowflake(
      agent.channelId,
      `Codex agent ${id} channelId`,
    ),
    model: String(agent.model ?? defaults.model ?? "").trim() || undefined,
    reasoningEffort,
    enabled: agent.enabled !== false,
    transport: agent.transport === "remote" ? "remote" : "local",
    online: agent.online !== false,
    ownerUserId: optionalSnowflake(
      agent.ownerUserId,
      `Codex agent ${id} ownerUserId`,
    ),
    ownerDisplayName:
      String(agent.ownerDisplayName ?? "")
        .trim()
        .slice(0, 80) || undefined,
    ownerAvatarUrl:
      String(agent.ownerAvatarUrl ?? "")
        .trim()
        .slice(0, 2_048) || undefined,
  });
}

export function parseCodexAgents(value, defaults = {}) {
  if (!String(value ?? "").trim()) {
    return [
      normalizeAgent(
        {
          id: "default",
          name: "Codex",
          capabilities: ["*"],
          maximumConcurrentTasks: defaults.maximumConcurrentTasks ?? 1,
        },
        0,
        defaults,
      ),
    ];
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `PERSONAL_CONTEXT_VOICE_CODEX_AGENTS must be valid JSON: ${error.message}`,
    );
  }
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 12)
    throw new Error(
      "PERSONAL_CONTEXT_VOICE_CODEX_AGENTS must contain 1 through 12 agents.",
    );
  const agents = parsed.map((agent, index) =>
    normalizeAgent(agent, index, defaults),
  );
  if (new Set(agents.map(({ id }) => id)).size !== agents.length)
    throw new Error("Codex agent ids must be unique.");
  if (!agents.some(({ enabled }) => enabled))
    throw new Error("At least one Codex agent must be enabled.");
  return agents;
}

function capabilityScore(agent, task) {
  const text = [task.kind, task.title, task.request]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return agent.capabilities.reduce((score, capability) => {
    if (capability === "*") return score + 1;
    return text.includes(capability) ? score + 10 : score;
  }, 0);
}

export class CodexAgentTeam {
  constructor(agents) {
    this.agents = new Map(
      agents.filter(({ enabled }) => enabled).map((agent) => [agent.id, agent]),
    );
    if (!this.agents.size)
      throw new Error("No enabled Codex agents configured.");
    this.active = new Map([...this.agents.keys()].map((id) => [id, 0]));
  }

  list() {
    return [...this.agents.values()];
  }

  upsert(agent) {
    if (!agent?.id) throw new Error("A Codex agent id is required.");
    const current = this.agents.get(agent.id);
    const normalized = Object.freeze({
      ...current,
      ...agent,
      capabilities: normalizeCapabilities(agent.capabilities),
      maximumConcurrentTasks: Math.max(
        1,
        Math.min(4, Number(agent.maximumConcurrentTasks) || 1),
      ),
      enabled: agent.enabled !== false,
      online: agent.online !== false,
    });
    this.agents.set(normalized.id, normalized);
    if (!this.active.has(normalized.id)) this.active.set(normalized.id, 0);
    return normalized;
  }

  setOnline(id, online) {
    const agent = this.agents.get(id);
    if (!agent) return undefined;
    return this.upsert({ ...agent, online: Boolean(online) });
  }

  get(id) {
    return this.agents.get(id);
  }

  assign(task, existingTasks = [], { force = false, exclude = [] } = {}) {
    const existing = this.get(task.assignedAgentId);
    const owned = (agent) =>
      !task.workerOwnerUserId ||
      (agent?.transport === "remote" &&
        agent.ownerUserId === task.workerOwnerUserId);
    if (
      existing &&
      owned(existing) &&
      (existing.online !== false || task.workerOwnerUserId) &&
      !force
    ) {
      task.assignedAgentName = existing.name;
      task.issueId ??= task.id;
      return existing;
    }
    const load = new Map([...this.agents.keys()].map((id) => [id, 0]));
    for (const candidate of existingTasks) {
      if (!ACTIVE_STATES.has(candidate.state)) continue;
      if (load.has(candidate.assignedAgentId))
        load.set(
          candidate.assignedAgentId,
          load.get(candidate.assignedAgentId) + 1,
        );
    }
    const excluded = new Set(exclude);
    const eligible = this.list().filter(
      (agent) =>
        owned(agent) &&
        agent.enabled !== false &&
        agent.online !== false &&
        !excluded.has(agent.id),
    );
    if (!eligible.length) return undefined;
    const candidates = eligible.map((agent) => ({
      agent,
      affinity: capabilityScore(agent, task),
      load: load.get(agent.id) ?? 0,
    }));
    const available = candidates.filter(
      ({ agent, load: assigned }) => assigned < agent.maximumConcurrentTasks,
    );
    const ranked = (available.length ? available : candidates).sort(
      (left, right) =>
        right.affinity - left.affinity ||
        Number(right.agent.transport === "remote") -
          Number(left.agent.transport === "remote") ||
        left.load / left.agent.maximumConcurrentTasks -
          right.load / right.agent.maximumConcurrentTasks ||
        left.agent.id.localeCompare(right.agent.id),
    );
    const selected = ranked[0];
    task.issueId ??= task.id;
    task.assignedAgentId = selected.agent.id;
    task.assignedAgentName = selected.agent.name;
    task.assignedAgentTransport = selected.agent.transport ?? "local";
    task.assignedAgentOwnerUserId = selected.agent.ownerUserId;
    task.assignedAt ??= Date.now();
    task.assignmentReason = selected.affinity
      ? `担当領域が依頼に一致（score ${selected.affinity}、割当済み ${selected.load}件）`
      : `担当領域の一致なし。割当負荷が最小（割当済み ${selected.load}件）`;
    return selected.agent;
  }

  reassign(task, existingTasks = [], exclude = []) {
    return this.assign(task, existingTasks, { force: true, exclude });
  }

  selectReviewer(task) {
    return this.list()
      .filter(
        ({ id, transport, online }) =>
          id !== task.assignedAgentId &&
          transport !== "remote" &&
          online !== false,
      )
      .sort(
        (left, right) =>
          capabilityScore(right, task) - capabilityScore(left, task) ||
          (this.active.get(left.id) ?? 0) / left.maximumConcurrentTasks -
            (this.active.get(right.id) ?? 0) / right.maximumConcurrentTasks ||
          left.id.localeCompare(right.id),
      )[0];
  }

  canRun(task) {
    const agent = this.get(task.assignedAgentId);
    return Boolean(
      agent &&
      agent.enabled !== false &&
      (!task.workerOwnerUserId ||
        (agent.transport === "remote" &&
          agent.ownerUserId === task.workerOwnerUserId)) &&
      agent.online !== false &&
      (this.active.get(agent.id) ?? 0) < agent.maximumConcurrentTasks,
    );
  }

  start(task) {
    const agent = this.get(task.assignedAgentId);
    if (!agent || !this.canRun(task)) return false;
    this.active.set(agent.id, (this.active.get(agent.id) ?? 0) + 1);
    return true;
  }

  finish(task) {
    const agent = this.get(task.assignedAgentId);
    if (!agent) return;
    this.active.set(
      agent.id,
      Math.max(0, (this.active.get(agent.id) ?? 0) - 1),
    );
  }
}
