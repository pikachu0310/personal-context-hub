import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";

class EventQueue {
  constructor() {
    this.items = [];
    this.waiters = [];
    this.ended = false;
  }
  push(item) {
    if (this.ended) return;
    if (this.waiters.length)
      this.waiters.shift().resolve({ value: item, done: false });
    else this.items.push(item);
  }
  end(error) {
    this.ended = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0))
      error ? waiter.reject(error) : waiter.resolve({ done: true });
  }
  next() {
    if (this.items.length)
      return Promise.resolve({ value: this.items.shift(), done: false });
    if (this.error) return Promise.reject(this.error);
    if (this.ended) return Promise.resolve({ done: true });
    return new Promise((resolve, reject) =>
      this.waiters.push({ resolve, reject }),
    );
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}

function configArgs(config, prefix = "") {
  return Object.entries(config ?? {}).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length
    )
      return configArgs(value, path);
    // Values in this adapter's config are JSON/TOML-compatible primitives,
    // arrays, or empty tables. These are argv values, never shell fragments.
    return ["-c", `${path}=${JSON.stringify(value)}`];
  });
}

function inputItems(input) {
  if (typeof input === "string") return [{ type: "text", text: input }];
  return input.map((item) =>
    item.type === "local_image" ? { ...item, type: "localImage" } : item,
  );
}

function sandboxPolicy(options) {
  const networkAccess = options.networkAccessEnabled === true;
  if (options.sandboxMode === "danger-full-access")
    return { type: "dangerFullAccess" };
  if (options.sandboxMode === "read-only")
    return { type: "readOnly", networkAccess };
  return {
    type: "workspaceWrite",
    networkAccess,
    writableRoots: [
      options.workingDirectory,
      ...(options.additionalDirectories ?? []),
    ].filter(Boolean),
  };
}

export function normalizeAppServerItem(item) {
  switch (item?.type) {
    case "agentMessage":
      return {
        id: item.id,
        type: "agent_message",
        text: item.text,
        phase: item.phase,
      };
    case "commandExecution":
      return {
        id: item.id,
        type: "command_execution",
        command: item.command,
        aggregated_output: item.aggregatedOutput ?? "",
        exit_code: item.exitCode ?? undefined,
        status: item.status === "inProgress" ? "in_progress" : item.status,
      };
    case "fileChange":
      return {
        id: item.id,
        type: "file_change",
        status: item.status,
        changes: (item.changes ?? []).map((change) => ({
          path: change.path,
          kind: change.kind?.type ?? change.kind,
        })),
      };
    case "webSearch":
      return { id: item.id, type: "web_search", query: item.query };
    case "mcpToolCall":
      return { ...item, type: "mcp_tool_call" };
    default:
      return undefined;
  }
}

function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.inputTokens ?? 0,
    cached_input_tokens: usage.cachedInputTokens ?? 0,
    cache_write_input_tokens: usage.cacheWriteInputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    reasoning_output_tokens: usage.reasoningOutputTokens ?? 0,
  };
}

// A small SDK-compatible facade over the documented App Server protocol.
// It adds active-turn steering without replacing the task/worktree/outbox code.
export class AppServerCodex extends EventEmitter {
  constructor(
    options = {},
    { spawnProcess = spawn, requestTimeoutMs = 30_000 } = {},
  ) {
    super();
    this.options = options;
    this.spawnProcess = spawnProcess;
    this.requestTimeoutMs = requestTimeoutMs;
    this.pending = new Map();
    this.sequence = 0;
    this.closed = false;
    this.threadUsage = new Map();
  }

  connect() {
    if (this.closed)
      return Promise.reject(new Error("Codex App Server is closed"));
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      this.child = this.spawnProcess(
        this.options.codexPathOverride ?? "codex",
        ["app-server", "--stdio", ...configArgs(this.options.config)],
        {
          env: this.options.env,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      this.child.stderr.on("data", () => {});
      this.child.stdin.on("error", (error) => this.fail(error));
      this.child.once("error", (error) => this.fail(error));
      this.child.once("exit", () =>
        this.fail(new Error("Codex App Server exited")),
      );
      this.lines = createInterface({ input: this.child.stdout });
      this.lines.on("line", (line) => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          return this.fail(new Error("Invalid Codex App Server message"));
        }
        if (message.id !== undefined && message.method) {
          // Never let a server-side approval request hang an unattended meeting.
          // Our tools run with approvalPolicy=never; unexpected requests fail closed.
          this.send({
            id: message.id,
            error: {
              code: -32601,
              message:
                "Interactive requests are not supported by the meeting worker",
            },
          });
        } else if (message.id !== undefined) {
          const pending = this.pending.get(message.id);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(message.id);
          if (message.error) {
            const error = new Error(
              message.error.message ?? "Codex request failed",
            );
            error.code = message.error.code;
            pending.reject(error);
          } else pending.resolve(message.result);
        } else if (message.method) this.emit("notification", message);
      });
      await this.requestRaw("initialize", {
        clientInfo: {
          name: "idobata_voice",
          title: "Idobata Voice",
          version: "1.0.0",
        },
      });
      this.send({ method: "initialized", params: {} });
    })();
    return this.connecting;
  }

  send(message) {
    if (this.closed || !this.child?.stdin.writable)
      throw new Error("Codex App Server is unavailable");
    this.child.stdin.write(JSON.stringify(message) + "\n");
  }

  requestRaw(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Codex request timed out: ${method}`);
        error.code = "CODEX_RPC_TIMEOUT";
        reject(error);
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params) {
    await this.connect();
    return this.requestRaw(method, params);
  }

  fail(error) {
    if (this.failed) return;
    this.failed = error;
    this.closed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.emit("failure", error);
    this.lines?.close();
    this.child?.kill();
  }

  startThread(options = {}) {
    return new AppServerThread(this, options);
  }
  resumeThread(id, options = {}) {
    return new AppServerThread(this, options, id);
  }

  async close() {
    if (!this.closed) this.fail(new Error("Codex App Server closed"));
    if (
      this.child &&
      this.child.exitCode === null &&
      this.child.signalCode === null
    ) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.child.kill("SIGKILL");
          resolve();
        }, 3_000);
        this.child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

class AppServerThread {
  constructor(client, options, id) {
    this.client = client;
    this.options = options;
    this.id = id ?? null;
    this.resuming = Boolean(id);
    this.activeTurnId = null;
  }

  async prepare() {
    if (!this.preparing)
      this.preparing = (async () => {
        const options = this.options;
        const response = await this.client.request(
          this.resuming ? "thread/resume" : "thread/start",
          {
            ...(this.resuming ? { threadId: this.id, excludeTurns: true } : {}),
            cwd: options.workingDirectory,
            model: options.model,
            sandbox: options.sandboxMode ?? "workspace-write",
            approvalPolicy: options.approvalPolicy ?? "never",
            config: {
              web_search: options.webSearchMode ?? "disabled",
              model_reasoning_effort: options.modelReasoningEffort ?? "low",
            },
          },
        );
        this.id = response.thread.id;
      })();
    return this.preparing;
  }

  async steer(text) {
    if (!this.activeTurnId || this.ending) return false;
    const turnId = this.activeTurnId;
    try {
      const result = await this.client.request("turn/steer", {
        threadId: this.id,
        expectedTurnId: turnId,
        input: inputItems(text),
      });
      return result.turnId === turnId;
    } catch (error) {
      // An explicit server rejection is safe to queue as a new turn. A timeout
      // or broken transport is ambiguous and must not duplicate the instruction.
      if (typeof error.code === "number") return false;
      throw error;
    }
  }

  async interrupt() {
    if (this.activeTurnId && !this.ending)
      await this.client.request("turn/interrupt", {
        threadId: this.id,
        turnId: this.activeTurnId,
      });
  }

  async runStreamed(input, turnOptions = {}) {
    return { events: this.stream(input, turnOptions) };
  }

  async *stream(input, { signal, outputSchema } = {}) {
    signal?.throwIfAborted();
    await this.prepare();
    if (this.activeTurnId || this.starting)
      throw new Error("A turn is already active");
    this.starting = true;
    this.ending = false;
    const queue = new EventQueue();
    let usage = null;
    let usageBaseline = this.client.threadUsage.get(this.id);
    let abortTimer;
    const onFailure = (error) => queue.end(error);
    const onNotification = ({ method, params }) => {
      if (params?.threadId !== this.id) return;
      const incomingTurn = params.turnId ?? params.turn?.id;
      if (
        this.activeTurnId &&
        incomingTurn &&
        incomingTurn !== this.activeTurnId
      )
        return;
      if (method === "turn/started") {
        this.activeTurnId = params.turn.id;
        queue.push({ type: "turn.started" });
      } else if (method === "thread/tokenUsage/updated") {
        const last = normalizeUsage(params.tokenUsage?.last);
        const total = normalizeUsage(params.tokenUsage?.total);
        if (total && last) {
          usageBaseline ??= Object.fromEntries(
            Object.entries(total).map(([key, value]) => [
              key,
              Math.max(0, value - last[key]),
            ]),
          );
          const monotonic = Object.entries(total).every(
            ([key, value]) => value >= usageBaseline[key],
          );
          usage = monotonic
            ? {
                ...Object.fromEntries(
                  Object.entries(total).map(([key, value]) => [
                    key,
                    value - usageBaseline[key],
                  ]),
                ),
                scope: "turn",
              }
            : { ...last, scope: "last_response_only" };
          this.client.threadUsage.set(this.id, total);
        } else usage = last ? { ...last, scope: "last_response_only" } : null;
      } else if (["item/started", "item/completed"].includes(method)) {
        const item = normalizeAppServerItem(params.item);
        if (item) queue.push({ type: method.replace("/", "."), item });
      } else if (method === "turn/completed") {
        this.ending = true;
        if (params.turn.status === "completed")
          queue.push({ type: "turn.completed", usage });
        else
          queue.push({
            type: "turn.failed",
            error: {
              message:
                params.turn.error?.message ??
                `Codex turn ${params.turn.status}`,
            },
          });
        queue.end();
      } else if (method === "error" && !params.willRetry) {
        queue.end(new Error(params.error?.message ?? "Codex turn failed"));
      }
    };
    const abort = () => {
      void this.interrupt().catch((error) => queue.end(error));
      abortTimer ??= setTimeout(() => {
        // The actual worker must stop before the queue reports cancellation.
        this.client.fail(new Error("Codex did not acknowledge cancellation"));
        queue.end(signal.reason ?? new Error("Codex turn aborted"));
      }, 5_000);
    };
    this.client.on("notification", onNotification);
    this.client.on("failure", onFailure);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const result = await this.client.request("turn/start", {
        threadId: this.id,
        input: inputItems(input),
        cwd: this.options.workingDirectory,
        model: this.options.model,
        effort: this.options.modelReasoningEffort ?? "low",
        approvalPolicy: this.options.approvalPolicy ?? "never",
        sandboxPolicy: sandboxPolicy(this.options),
        ...(outputSchema ? { outputSchema } : {}),
      });
      this.activeTurnId ??= result.turn.id;
      this.starting = false;
      if (signal?.aborted) abort();
      yield { type: "thread.started", thread_id: this.id };
      for await (const event of queue) yield event;
      signal?.throwIfAborted();
    } catch (error) {
      // A start timeout may have launched a worker without returning its ID.
      // Tear down the transport instead of leaving an untracked writer alive.
      if (this.starting && error.code === "CODEX_RPC_TIMEOUT")
        this.client.fail(error);
      throw error;
    } finally {
      clearTimeout(abortTimer);
      if (!this.ending && this.activeTurnId)
        await this.interrupt().catch(() => {});
      this.client.off("notification", onNotification);
      this.client.off("failure", onFailure);
      signal?.removeEventListener("abort", abort);
      this.starting = false;
      this.activeTurnId = null;
    }
  }

  async run(input, options) {
    const items = [];
    let finalResponse = "";
    let usage = null;
    for await (const event of this.stream(input, options)) {
      if (event.type === "item.completed") {
        items.push(event.item);
        if (event.item.type === "agent_message")
          finalResponse = event.item.text;
      }
      if (event.type === "turn.completed") usage = event.usage;
      if (event.type === "turn.failed") throw new Error(event.error.message);
    }
    return { items, finalResponse, usage };
  }
}
