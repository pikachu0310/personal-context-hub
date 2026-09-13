import { randomBytes, randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { identifyVerificationCommand } from "./engine/evidence.mjs";
import { taskModelSelection } from "./engine/model-policy.mjs";

const MAX_MESSAGE_BYTES = 256 * 1024;
const OPEN = 1;

function gatewayError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function safeTask(task, leaseId) {
  return {
    type: "task",
    leaseId,
    issueId: task.issueId ?? task.id,
    taskId: task.id,
    title: String(task.title ?? "").slice(0, 200),
    request: String(task.request ?? "").slice(0, 20_000),
    context: String(task.context ?? "").slice(0, 20_000),
    kind: task.kind,
    complexity: task.complexity,
    modelSelection: taskModelSelection(task),
    activeSpecRevision: task.activeSpecRevision,
    acceptanceCriteria: task.acceptanceCriteria
      ?.slice(0, 10)
      .map((criterion) => String(criterion).slice(0, 500)),
    sourceStatements: task.sourceStatements?.slice(0, 20).map((statement) => ({
      sequence: statement.sequence,
      text: String(statement.text ?? "").slice(0, 2000),
      speakerName: String(statement.speakerName ?? "").slice(0, 100),
    })),
    additionalInstruction: task.additionalInstruction,
    additionalInstructionSource: task.additionalInstructionSource,
  };
}

function parseMessage(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length > MAX_MESSAGE_BYTES)
    throw gatewayError(
      "WORKER_MESSAGE_TOO_LARGE",
      "Worker message is too large.",
    );
  const value = JSON.parse(buffer.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Worker message must be an object.");
  return value;
}

function boundedInteger(value, maximum = 1_000_000) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0
    ? Math.min(number, maximum)
    : 0;
}

function safeEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  return {
    runRevision: boundedInteger(value.runRevision),
    commands: boundedInteger(value.commands),
    failedCommands: boundedInteger(value.failedCommands),
    unknownCommands: boundedInteger(value.unknownCommands),
    tests: Array.isArray(value.tests)
      ? value.tests
          .slice(0, 100)
          .map((item) =>
            identifyVerificationCommand(
              typeof item?.command === "string"
                ? item.command.slice(0, 500)
                : "",
              item?.scope === "command_exit" ? item.exitCode : undefined,
            ),
          )
          .filter(Boolean)
      : [],
    files: Array.isArray(value.files)
      ? value.files.map((item) => String(item).slice(0, 500)).slice(0, 100)
      : [],
  };
}

function safeArtifacts(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const patchHash = /^[a-f0-9]{64}$/i.test(String(value.patchHash ?? ""))
    ? String(value.patchHash)
    : undefined;
  return {
    hasChanges: Boolean(value.hasChanges),
    status: String(value.status ?? "").slice(0, 20_000),
    runRevision: boundedInteger(value.runRevision),
    patchHash,
    note: String(value.note ?? "").slice(0, 500),
    remote: true,
  };
}

export function validateWorkerGatewayConfig({ host, publicUrl }) {
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
  const url = new URL(publicUrl);
  const publicLoopback = ["127.0.0.1", "[::1]", "localhost"].includes(
    url.hostname,
  );
  if (url.username || url.password || url.hash || url.search)
    throw new Error(
      "Worker gateway URL must not contain credentials, queries or fragments.",
    );
  if (!loopback)
    throw new Error(
      "Worker gateway must bind to loopback behind a TLS reverse proxy.",
    );
  if (url.protocol !== "wss:" && !(publicLoopback && url.protocol === "ws:"))
    throw new Error(
      "Worker gateway must use wss:// unless it is bound to loopback.",
    );
  return { loopback, url };
}

export class AgentWorkerGateway {
  constructor({
    registry,
    agentTeam,
    host = "127.0.0.1",
    port = 8787,
    publicUrl = `ws://${host}:${port}`,
    defaultWorkingDirectory,
    heartbeatTimeoutMs = 45_000,
    leaseTtlMs = 120_000,
    checkpoint = async () => undefined,
    onAvailability = () => undefined,
    logger = console,
    WebSocketServerClass = WebSocketServer,
    maximumConnections = 200,
    maximumUnauthenticatedConnections = 32,
    maximumMessagesPerWindow = 120,
    authorizeOwner = () => true,
  }) {
    validateWorkerGatewayConfig({ host, publicUrl });
    this.registry = registry;
    this.agentTeam = agentTeam;
    this.host = host;
    this.port = port;
    this.publicUrl = publicUrl;
    this.defaultWorkingDirectory = defaultWorkingDirectory;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.leaseTtlMs = leaseTtlMs;
    this.checkpoint = checkpoint;
    this.onAvailability = onAvailability;
    this.logger = logger;
    this.WebSocketServerClass = WebSocketServerClass;
    this.maximumConnections = maximumConnections;
    this.maximumUnauthenticatedConnections = maximumUnauthenticatedConnections;
    this.maximumMessagesPerWindow = maximumMessagesPerWindow;
    this.authorizeOwner = authorizeOwner;
    this.sessions = new Map();
    this.connections = new Map();
    this.pending = new Map();
  }

  async start() {
    if (this.server) return this;
    this.server = new this.WebSocketServerClass({
      host: this.host,
      port: this.port,
      maxPayload: MAX_MESSAGE_BYTES,
      // Browser pages have no reason to talk directly to this machine protocol.
      verifyClient: ({ origin }) => !origin,
    });
    this.server.on("connection", (socket) => this.#accept(socket));
    await new Promise((resolve, reject) => {
      const ready = () => {
        this.server.off("error", reject);
        resolve();
      };
      this.server.once("listening", ready);
      this.server.once("error", reject);
    });
    this.sweepTimer = setInterval(
      () => this.#sweep(),
      Math.max(5_000, Math.floor(this.heartbeatTimeoutMs / 3)),
    );
    this.sweepTimer.unref?.();
    return this;
  }

  address() {
    return this.server?.address?.();
  }

  async createPairing(identity) {
    if (!(await this.authorizeOwner(identity.ownerUserId)))
      throw gatewayError(
        "WORKER_OWNER_DENIED",
        "This owner is not allowed to register a Worker.",
      );
    return {
      ...this.registry.createPairing(identity),
      gatewayUrl: this.publicUrl,
    };
  }

  async revokeOwner(ownerUserId) {
    const revoked = this.registry.revokeOwner(ownerUserId);
    for (const agentId of revoked) {
      this.connections.get(agentId)?.close(4003, "Worker enrollment revoked");
      this.connections.delete(agentId);
      this.agentTeam?.setOnline(agentId, false);
      this.#rejectAgent(
        agentId,
        "WORKER_REVOKED",
        "Worker enrollment was revoked.",
      );
    }
    if (revoked.length) await this.checkpoint(this.registry.snapshot());
    return revoked;
  }

  statusForOwner(ownerUserId) {
    return this.registry.byOwner(ownerUserId);
  }

  hasAgent(agentId) {
    return Boolean(this.registry.describe(agentId));
  }

  isOnline(agentId) {
    return Boolean(this.registry.describe(agentId)?.online);
  }

  async runTask(task, { signal, onProgress } = {}) {
    const agentId = task.assignedAgentId;
    const socket = this.connections.get(agentId);
    if (!socket || socket.readyState !== OPEN)
      throw gatewayError("WORKER_OFFLINE", "Assigned worker is offline.");
    const leaseId = randomUUID();
    const lease = {
      leaseId,
      agentId,
      task,
      onProgress,
      expiresAt: Date.now() + this.leaseTtlMs,
    };
    const result = new Promise((resolve, reject) => {
      lease.resolve = resolve;
      lease.reject = reject;
    });
    this.pending.set(leaseId, lease);
    const abort = () => {
      socket.send(JSON.stringify({ type: "cancel", leaseId }));
      this.#settle(
        leaseId,
        signal.reason ?? gatewayError("TASK_CANCELLED", "Task cancelled."),
        true,
      );
    };
    signal?.addEventListener("abort", abort, { once: true });
    lease.removeAbort = () => signal?.removeEventListener("abort", abort);
    socket.send(JSON.stringify(safeTask(task, leaseId)));
    return result;
  }

  async stop() {
    clearInterval(this.sweepTimer);
    for (const leaseId of [...this.pending.keys()])
      this.#settle(
        leaseId,
        gatewayError("WORKER_GATEWAY_STOPPED", "Worker gateway stopped."),
        true,
      );
    for (const socket of this.server?.clients ?? this.connections.values())
      socket.close(1001, "Server stopped");
    this.connections.clear();
    if (!this.server) return;
    const server = this.server;
    this.server = undefined;
    await new Promise((resolve) => server.close(resolve));
  }

  #accept(socket) {
    if (
      this.sessions.size >= this.maximumConnections ||
      [...this.sessions.values()].filter((value) => !value.agentId).length >=
        this.maximumUnauthenticatedConnections
    ) {
      socket.close(1013, "Gateway connection limit reached");
      return;
    }
    const session = {
      challenge: randomBytes(32).toString("base64url"),
      challengeExpiresAt: Date.now() + 30_000,
      agentId: undefined,
      windowStartedAt: Date.now(),
      messageCount: 0,
      queued: 0,
      processing: Promise.resolve(),
    };
    this.sessions.set(socket, session);
    session.challengeTimer = setTimeout(
      () => {
        if (!session.agentId && socket.readyState === OPEN)
          socket.close(4008, "Worker challenge expired");
      },
      Math.max(0, session.challengeExpiresAt - Date.now()),
    );
    session.challengeTimer.unref?.();
    socket.send(
      JSON.stringify({
        type: "challenge",
        challenge: session.challenge,
        expiresAt: session.challengeExpiresAt,
      }),
    );
    socket.on("message", (data) => {
      if (Date.now() - session.windowStartedAt >= 10_000) {
        session.windowStartedAt = Date.now();
        session.messageCount = 0;
      }
      if (
        ++session.messageCount > this.maximumMessagesPerWindow ||
        session.queued >= 16
      ) {
        socket.close(4002, "Worker message limit reached");
        return;
      }
      session.queued++;
      session.processing = session.processing
        .then(() => {
          if (socket.readyState !== OPEN) return;
          return this.#message(socket, session, data);
        })
        .catch((error) => {
          this.logger.warn?.({
            component: "agent-worker-gateway",
            event: "message_rejected",
            code: error?.code ?? "WORKER_MESSAGE_INVALID",
          });
          if (socket.readyState === OPEN)
            socket.send(
              JSON.stringify({
                type: "error",
                code: error?.code ?? "WORKER_MESSAGE_INVALID",
                message: "Worker request was rejected.",
              }),
            );
          socket.close(4002, "Worker request rejected");
        })
        .finally(() => {
          session.queued--;
        });
    });
    socket.on("close", () => {
      clearTimeout(session.challengeTimer);
      this.sessions.delete(socket);
      if (!session.agentId) return;
      if (this.connections.get(session.agentId) !== socket) return;
      this.connections.delete(session.agentId);
      this.registry.markOnline(session.agentId, false);
      this.agentTeam?.setOnline(session.agentId, false);
      this.#rejectAgent(
        session.agentId,
        "WORKER_DISCONNECTED",
        "Worker disconnected before completing its lease.",
      );
      void this.checkpoint(this.registry.snapshot()).catch(() => undefined);
      this.onAvailability();
    });
  }

  async #message(socket, session, data) {
    const message = parseMessage(data);
    if (!session.agentId) {
      if (session.challengeExpiresAt < Date.now())
        throw gatewayError(
          "WORKER_CHALLENGE_EXPIRED",
          "Worker challenge expired.",
        );
      if (message.type === "pair") {
        if (
          !(await this.authorizeOwner(this.registry.pairingOwner(message.code)))
        )
          throw gatewayError(
            "WORKER_OWNER_DENIED",
            "Worker owner is no longer allowed to enroll.",
          );
        this.#assertActive(socket, session);
        const paired = this.registry.completePairing({
          ...message,
          challenge: session.challenge,
        });
        await this.checkpoint(this.registry.snapshot());
        this.#register(socket, session, paired.agentId, paired.worker);
        socket.send(
          JSON.stringify({
            type: "paired",
            agentId: paired.agentId,
            token: paired.token,
          }),
        );
        return;
      }
      if (
        message.type !== "authenticate" ||
        !(await this.authorizeOwner(
          this.registry.describe?.(message.agentId)?.ownerUserId,
        )) ||
        !this.registry.authenticate({
          ...message,
          challenge: session.challenge,
        })
      )
        throw gatewayError(
          "WORKER_AUTH_FAILED",
          "Worker authentication failed.",
        );
      this.#assertActive(socket, session);
      const worker = this.registry.markOnline(message.agentId, true);
      this.#register(socket, session, message.agentId, worker);
      socket.send(
        JSON.stringify({ type: "authenticated", agentId: message.agentId }),
      );
      await this.checkpoint(this.registry.snapshot());
      return;
    }
    // Replaced/revoked sockets must not extend or settle a new connection's lease.
    if (
      !(await this.authorizeOwner(
        this.registry.describe(session.agentId)?.ownerUserId,
      )) ||
      this.connections.get(session.agentId) !== socket ||
      !this.registry.describe(session.agentId) ||
      socket.readyState !== 1
    )
      throw gatewayError(
        "WORKER_AUTH_FAILED",
        "Worker connection is no longer registered.",
      );
    if (message.type === "heartbeat") {
      this.registry.heartbeat(session.agentId);
      for (const lease of this.pending.values())
        if (lease.agentId === session.agentId)
          lease.expiresAt = Date.now() + this.leaseTtlMs;
      socket.send(JSON.stringify({ type: "heartbeat_ack", at: Date.now() }));
      return;
    }
    const lease = this.pending.get(message.leaseId);
    if (!lease || lease.agentId !== session.agentId) return;
    lease.expiresAt = Date.now() + this.leaseTtlMs;
    if (message.type === "progress") {
      await lease.onProgress?.(String(message.content ?? "").slice(0, 1_900));
      return;
    }
    if (message.type === "result") {
      lease.task.codexThreadId = String(message.codexThreadId ?? "").slice(
        0,
        200,
      );
      lease.task.runRevision = boundedInteger(message.runRevision);
      lease.task.evidence = safeEvidence(message.evidence);
      lease.task.artifacts = safeArtifacts(message.artifacts);
      lease.task.remoteExecution = true;
      this.#settle(
        message.leaseId,
        String(message.result ?? "").slice(0, 100_000),
        false,
      );
      return;
    }
    if (message.type === "task_error") {
      this.#settle(
        message.leaseId,
        gatewayError(
          "WORKER_TASK_FAILED",
          String(message.message ?? "Worker task failed."),
        ),
        true,
      );
    }
  }

  #assertActive(socket, session) {
    if (
      socket.readyState !== 1 ||
      this.sessions.get(socket) !== session ||
      (!session.agentId && session.challengeExpiresAt < Date.now())
    )
      throw gatewayError(
        "WORKER_AUTH_FAILED",
        "Worker session is no longer active.",
      );
  }

  #register(socket, session, agentId, worker) {
    this.#assertActive(socket, session);
    clearTimeout(session.challengeTimer);
    const previous = this.connections.get(agentId);
    session.agentId = agentId;
    this.connections.set(agentId, socket);
    if (previous && previous !== socket)
      previous.close(4001, "Replaced by a new connection");
    this.agentTeam?.upsert({
      ...worker,
      id: agentId,
      workingDirectory: this.defaultWorkingDirectory,
      transport: "remote",
      online: true,
    });
    this.onAvailability();
  }

  #settle(leaseId, value, rejected) {
    const lease = this.pending.get(leaseId);
    if (!lease) return;
    this.pending.delete(leaseId);
    lease.removeAbort?.();
    if (rejected) lease.reject(value);
    else lease.resolve(value);
  }

  #rejectAgent(agentId, code, message) {
    for (const [leaseId, lease] of this.pending)
      if (lease.agentId === agentId)
        this.#settle(leaseId, gatewayError(code, message), true);
  }

  #sweep() {
    const now = Date.now();
    for (const [agentId] of this.connections) {
      const worker = this.registry.describe(agentId);
      if (worker && now - worker.lastSeenAt <= this.heartbeatTimeoutMs)
        continue;
      this.connections.get(agentId)?.close(4000, "Heartbeat timed out");
    }
    for (const [leaseId, lease] of this.pending)
      if (lease.expiresAt < now) {
        const socket = this.connections.get(lease.agentId);
        if (socket?.readyState === OPEN)
          socket.send(JSON.stringify({ type: "cancel", leaseId }));
        this.#settle(
          leaseId,
          gatewayError("WORKER_LEASE_EXPIRED", "Worker lease expired."),
          true,
        );
      }
  }
}
