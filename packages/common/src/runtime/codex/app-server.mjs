import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { AppServerThread } from "./thread.mjs";
export { normalizeAppServerItem } from "./events.mjs";

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
        [
          "app-server",
          "--listen",
          "stdio://",
          ...configArgs(this.options.config),
        ],
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
          if (
            this.options.onApprovalRequest &&
            [
              "item/commandExecution/requestApproval",
              "item/fileChange/requestApproval",
              "item/permissions/requestApproval",
            ].includes(message.method)
          ) {
            void Promise.resolve()
              .then(() =>
                this.options.onApprovalRequest(
                  message.method,
                  message.params ?? {},
                ),
              )
              .then((result) => {
                if (!this.closed)
                  this.send({
                    id: message.id,
                    result:
                      message.method === "item/permissions/requestApproval"
                        ? {
                            permissions:
                              result?.decision === "accept"
                                ? (message.params?.permissions ?? {})
                                : {},
                            scope: "turn",
                          }
                        : {
                            decision:
                              result?.decision === "accept"
                                ? "accept"
                                : "decline",
                          },
                  });
              })
              .catch(() => {
                if (!this.closed)
                  this.send({
                    id: message.id,
                    result:
                      message.method === "item/permissions/requestApproval"
                        ? { permissions: {}, scope: "turn" }
                        : { decision: "decline" },
                  });
              });
            return;
          }
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
