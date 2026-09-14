import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { realpath } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { WebSocket } from "ws";
import {
  atomic,
  json,
  secret,
  equal,
  hash,
  run,
  workerEnvironment,
} from "../../common/src/platform.js";
import { Credentials } from "../../common/src/credentials.js";
import {
  headers,
  localGuard,
  body,
  send,
  asset,
  HttpError,
} from "../../common/src/http.js";
import {
  frame,
  endpoint,
  text,
  id,
  type Mapping,
  type Project,
  type Command,
} from "../../common/src/protocol.js";
import { Executor, codexBinary } from "./executor.js";
import { ClientPreview } from "./preview.js";

interface Settings {
  engineUrl?: string;
  deviceId?: string;
  publicKey?: string;
  mappings: Mapping[];
  slots: number;
  projects: Project[];
}
export class Client {
  settings: Settings = { mappings: [], slots: 1, projects: [] };
  credentials: Credentials;
  executor: Executor;
  preview: ClientPreview;
  csrf = secret();
  origin = "";
  generation = 0;
  connected = false;
  allow = false;
  stopping = false;
  ws?: WebSocket;
  reconnect?: NodeJS.Timeout;
  pairing?: { id: string; proof: string; url: string; fingerprint: string };
  pairTimer?: NodeJS.Timeout;
  status = "offline";
  login?: ChildProcess;
  loginStatus = "not checked";
  private processing: Promise<unknown> = Promise.resolve();
  server = createServer(
    (req, res) =>
      void this.route(req, res).catch((e) => {
        if (!res.headersSent)
          send(res, e instanceof HttpError ? e.status : 400, {
            error: e instanceof HttpError ? e.message : "REQUEST_FAILED",
          });
      }),
  );
  constructor(
    readonly directory: string,
    readonly uiDirectory = join(dirname(fileURLToPath(import.meta.url)), "ui"),
  ) {
    this.credentials = new Credentials(directory, "ido-client");
    this.executor = new Executor(directory, (data) => this.emit(data));
    this.preview = new ClientPreview((data) => this.emit(data));
  }
  async start(port = 4320) {
    this.settings = await json(
      join(this.directory, "client.json"),
      this.settings,
    );
    await this.executor.load();
    if (!this.settings.publicKey) {
      const keys = generateKeyPairSync("ed25519");
      this.settings.publicKey = keys.publicKey
        .export({ format: "pem", type: "spki" })
        .toString();
      await this.credentials.set(
        "device.privateKey",
        keys.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
      );
      await this.save();
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    this.origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
    if (this.settings.deviceId) this.connect();
    return this;
  }
  save() {
    return atomic(join(this.directory, "client.json"), this.settings);
  }
  emit(data: Command) {
    if (this.ws?.readyState === WebSocket.OPEN && this.connected)
      this.ws.send(JSON.stringify({ ...data, generation: this.generation }));
  }
  grants() {
    return this.allow
      ? this.settings.mappings.map(
          ({ directory, previewCommand, ...grant }) => grant,
        )
      : [];
  }
  ready() {
    this.emit({
      v: 1,
      type: "ready",
      grants: this.grants(),
      slots: this.settings.slots,
    });
  }
  async connect() {
    if (this.stopping || !this.settings.engineUrl || !this.settings.deviceId)
      return;
    clearTimeout(this.reconnect);
    this.ws?.close();
    this.connected = false;
    this.status = "connecting";
    const privateKey = await this.credentials.get("device.privateKey");
    if (!privateKey) {
      this.status = "device key unavailable";
      return;
    }
    const url = new URL("/connect", this.settings.engineUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, {
      maxPayload: 3 * 1024 * 1024,
      perMessageDeflate: false,
      handshakeTimeout: 10000,
    });
    this.ws = ws;
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      let data: Command;
      try {
        data = frame(raw.toString());
      } catch {
        ws.close();
        return;
      }
      if (data.type === "challenge") {
        ws.send(
          JSON.stringify({
            v: 1,
            type: "authenticate",
            deviceId: this.settings.deviceId,
            signature: sign(
              null,
              Buffer.from(
                `ido:1:${this.settings.deviceId}:${String(data.challenge)}`,
              ),
              privateKey,
            ).toString("base64"),
          }),
        );
        return;
      }
      if (data.type === "authenticated") {
        this.generation = Number(data.generation);
        this.connected = true;
        this.status = "connected";
        this.settings.projects = data.projects as Project[];
        void this.save();
        for (const value of Object.values(this.executor.runs))
          this.executor.report(value);
        this.ready();
        return;
      }
      if (data.type.startsWith("preview.")) {
        void this.preview.receive(data).catch(() => {});
        return;
      }
      if (data.generation !== this.generation) return;
      if (data.type === "artifact.request") {
        const value = this.executor.runs[String(data.runId)];
        if (
          !value ||
          value.task.id !== data.taskId ||
          value.task.revision !== data.revision
        )
          return;
        void this.executor
          .artifact(value.task.runId)
          .then((artifact) =>
            this.emit({
              v: 1,
              type: "artifact.result",
              requestId: data.requestId,
              taskId: value.task.id,
              runId: value.task.runId,
              ...artifact,
            }),
          )
          .catch(() =>
            this.emit({
              v: 1,
              type: "artifact.result",
              requestId: data.requestId,
              taskId: value.task.id,
              runId: value.task.runId,
              revision: value.task.revision,
              error: "DIFF_UNAVAILABLE",
            }),
          );
        return;
      }
      this.processing = this.processing
        .catch(() => {})
        .then(() =>
          this.executor.receive(
            data,
            this.settings.mappings,
            this.allow,
            this.settings.slots,
          ),
        )
        .catch(() => {
          this.status = "command failed; check local execution";
        });
    });
    ws.once("close", (code) => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.status = code === 4003 ? "revoked or permission changed" : "offline";
      this.preview.close();
      if (!this.stopping && code !== 4003)
        this.reconnect = setTimeout(() => void this.connect(), 3000);
    });
  }
  async pair(engineUrl: string) {
    if (this.settings.deviceId)
      throw new Error(
        "ALREADY_PAIRED: revoke and disconnect this device before changing engines",
      );
    const origin = endpoint(engineUrl).origin;
    this.settings.engineUrl = origin;
    const response = await fetch(origin + "/api/pair/request", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: hostname(),
        publicKey: this.settings.publicKey,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error("PAIR_REQUEST_FAILED");
    const result = (await response.json()) as {
      id: string;
      proof: string;
      url: string;
    };
    this.pairing = {
      ...result,
      url: `${origin}/pair/${result.id}`,
      fingerprint: hash(this.settings.publicKey!),
    };
    this.pollPair();
  }
  pollPair() {
    clearTimeout(this.pairTimer);
    this.pairTimer = setTimeout(() => {
      void (async () => {
        const pair = this.pairing;
        if (!pair || !this.settings.engineUrl) return;
        const response = await fetch(
          this.settings.engineUrl + "/api/pair/poll",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: pair.id, proof: pair.proof }),
            signal: AbortSignal.timeout(10000),
          },
        );
        if (!response.ok) {
          this.pairing = undefined;
          this.status = "pairing expired";
          return;
        }
        const result = (await response.json()) as {
          pending?: boolean;
          deviceId: string;
          projects: Project[];
        };
        if (result.pending) {
          this.pollPair();
          return;
        }
        this.settings.deviceId = result.deviceId;
        this.settings.projects = result.projects;
        await this.save();
        this.pairing = undefined;
        await this.connect();
      })().catch(() => {
        this.status = "pairing network error";
        this.pollPair();
      });
    }, 2000);
  }
  async route(req: IncomingMessage, res: ServerResponse) {
    headers(res);
    localGuard(req, this.origin);
    const url = new URL(req.url ?? "/", this.origin);
    if (url.pathname === "/health") {
      send(res, 200, { ok: true, service: "ido-client", protocol: 1 });
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await asset(req, res, this.uiDirectory, url.pathname);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/state") {
      send(res, 200, {
        mode: "client",
        csrf: this.csrf,
        settings: this.settings,
        connected: this.connected,
        status: this.status,
        allow: this.allow,
        loginStatus: this.loginStatus,
        pairing: this.pairing
          ? { url: this.pairing.url, fingerprint: this.pairing.fingerprint }
          : null,
        runs: Object.values(this.executor.runs),
        approvals: [...this.executor.approvals].map(
          ([id, { method, params }]) => ({ id, method, params }),
        ),
      });
      return;
    }
    if (
      req.method !== "POST" ||
      !equal(String(req.headers["x-csrf-token"] ?? ""), this.csrf)
    )
      throw new HttpError(403, "CSRF_REQUIRED");
    const input = await body(req);
    switch (url.pathname) {
      case "/api/pair":
        await this.pair(text(input.engineUrl, 2048));
        break;
      case "/api/disconnect": {
        if (this.executor.active.size)
          throw new HttpError(409, "STOP_TASKS_FIRST");
        this.allow = false;
        this.settings.deviceId = undefined;
        this.settings.engineUrl = undefined;
        this.settings.projects = [];
        this.settings.mappings = [];
        clearTimeout(this.reconnect);
        this.ws?.close();
        this.connected = false;
        this.preview.close();
        await this.save();
        break;
      }
      case "/api/mappings": {
        if (this.allow || this.executor.active.size)
          throw new HttpError(409, "PAUSE_BEFORE_EDITING");
        const directory = await realpath(text(input.directory, 4000));
        await run("git", ["-C", directory, "rev-parse", "--show-toplevel"]);
        const projectId = id(input.projectId);
        if (!this.settings.projects.some((p) => p.id === projectId))
          throw new HttpError(400, "UNKNOWN_PROJECT");
        this.settings.mappings = this.settings.mappings
          .filter((m) => m.projectId !== projectId)
          .concat({
            projectId,
            directory,
            network: input.network === true,
            slots: Math.max(1, Math.min(8, Number(input.slots) || 1)),
          });
        await this.save();
        break;
      }
      case "/api/allow":
        this.allow = input.allow === true;
        this.settings.slots = Math.max(
          1,
          Math.min(8, Number(input.slots) || 1),
        );
        await this.save();
        this.ready();
        break;
      case "/api/approval":
        this.executor.approve(id(input.id), input.allow === true);
        break;
      case "/api/codex/doctor":
        try {
          await run(codexBinary(), ["login", "status"], {
            env: workerEnvironment(this.executor.home),
          });
          this.loginStatus = "authenticated";
        } catch {
          this.loginStatus = "login required";
        }
        break;
      case "/api/codex/login": {
        if (this.login) throw new Error("LOGIN_ALREADY_RUNNING");
        this.loginStatus = "Follow the official Codex login in the terminal.";
        const child = spawn(codexBinary(), ["login", "--device-auth"], {
          env: workerEnvironment(this.executor.home),
          stdio: "inherit",
        });
        this.login = child;
        child.once("error", () => {
          this.loginStatus = "Codex unavailable";
          this.login = undefined;
        });
        child.once("exit", (code) => {
          this.loginStatus = code === 0 ? "authenticated" : "login failed";
          this.login = undefined;
        });
        break;
      }
      case "/api/stop": {
        const value = this.executor.runs[id(input.runId)];
        if (!value) throw new Error("RUN_NOT_FOUND");
        await this.executor.receive(
          {
            v: 1,
            type: "stop",
            id: randomUUID(),
            runId: value.task.runId,
            taskId: value.task.id,
          },
          this.settings.mappings,
          this.allow,
          this.settings.slots,
        );
        break;
      }
      case "/api/preview": {
        const value = this.executor.runs[id(input.runId)];
        if (!value) throw new Error("RUN_NOT_FOUND");
        const port = Number(input.port);
        if ([new URL(this.origin).port].includes(String(port)))
          throw new Error("MANAGEMENT_PORT_FORBIDDEN");
        if (!Number.isInteger(port) || port < 1024 || port > 65535)
          throw new Error("INVALID_PORT");
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`, {
            redirect: "error",
            signal: AbortSignal.timeout(1500),
          });
          const info = (await response.json()) as { service?: string };
          if (info.service?.startsWith("ido-"))
            throw new HttpError(403, "MANAGEMENT_PORT_FORBIDDEN");
        } catch (e) {
          if (e instanceof HttpError) throw e;
        }
        const previewId = randomUUID();
        this.preview.register(previewId, port);
        this.emit({
          v: 1,
          type: "preview.register",
          previewId,
          taskId: value.task.id,
          runId: value.task.runId,
          revision: value.task.revision,
        });
        break;
      }
      default:
        throw new HttpError(404, "NOT_FOUND");
    }
    send(res, 200, { ok: true });
  }
  async close() {
    this.stopping = true;
    clearTimeout(this.reconnect);
    clearTimeout(this.pairTimer);
    this.login?.kill();
    this.ws?.close();
    this.preview.close();
    await this.executor.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
