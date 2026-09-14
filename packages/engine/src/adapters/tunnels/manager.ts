import { fork, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { endpoint } from "../../../../common/src/contracts/protocol.js";
import { Credentials } from "../../../../common/src/runtime/credentials.js";
import { HttpError } from "../../../../common/src/runtime/http.js";
import {
  npmRun,
  workerEnvironment,
} from "../../../../common/src/runtime/platform.js";
import { Store } from "../sqlite/store.js";
export class Tunnels {
  child?: ChildProcess;
  status = "stopped";
  busy = false;
  error?: string;
  starting = false;
  workerPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "tunnel-worker.js",
  );
  startupTimer?: NodeJS.Timeout;
  constructor(
    readonly directory: string,
    readonly store: Store,
    readonly credentials: Credentials,
  ) {}
  async install(provider: string) {
    const catalog: Record<string, string> = {
      cloudflare: "cloudflared@0.7.3",
      ngrok: "@ngrok/ngrok@1.7.0",
    };
    if (!catalog[provider] || this.busy) throw new Error("INVALID_PROVIDER");
    this.busy = true;
    try {
      const root = join(this.directory, "tunnels", provider);
      await mkdir(root, { recursive: true, mode: 0o700 });
      await npmRun(
        [
          "install",
          "--prefix",
          root,
          "--omit=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          catalog[provider],
        ],
        { timeout: 180000 },
      );
      this.store.put("tunnel", provider, {
        directory: root,
        package: catalog[provider],
      });
    } finally {
      this.busy = false;
    }
  }
  async start(
    provider: string,
    ports: { engine: number },
    requestedUrl?: string,
  ) {
    if (!["ngrok", "cloudflare"].includes(provider))
      throw new HttpError(400, "INVALID_PROVIDER");
    if (this.starting || this.busy || this.status === "starting")
      throw new HttpError(409, "TUNNEL_BUSY");
    this.starting = true;
    this.error = undefined;
    try {
      const secret = await this.credentials.get(`tunnel.${provider}`);
      if (!secret) throw new HttpError(400, "TUNNEL_CREDENTIAL_REQUIRED");
      const config = this.store.get<Record<string, string>>("config", "public");
      // ngrok can assign the account's dev domain. Do not reuse an old provider's URL.
      const engineUrl = requestedUrl
        ? endpoint(requestedUrl).origin
        : provider === "cloudflare"
          ? config?.engineUrl
          : undefined;
      if (engineUrl && !engineUrl.startsWith("https:"))
        throw new HttpError(400, "PUBLIC_HTTPS_REQUIRED");
      if (provider === "cloudflare" && !engineUrl)
        throw new HttpError(400, "PUBLIC_URL_REQUIRED");
      if (!this.store.get("tunnel", provider)) {
        this.status = "installing";
        try {
          await this.install(provider);
        } catch {
          throw new HttpError(502, "TUNNEL_INSTALL_FAILED");
        }
      }
      const installation = this.store.get<{ directory: string }>(
        "tunnel",
        provider,
      )!;
      this.stop();
      this.status = "starting";
      const child = fork(this.workerPath, [], {
        env: workerEnvironment(this.directory),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      });
      this.child = child;
      this.startupTimer = setTimeout(() => {
        if (this.child !== child) return;
        this.error = "TUNNEL_START_TIMEOUT";
        this.status = "failed";
        child.kill();
      }, 30000);
      child.on("message", (message: any) => {
        if (this.child !== child) return;
        if (message.type === "public-url") {
          try {
            const url = endpoint(message.url).origin;
            if (!url.startsWith("https:")) throw new Error("HTTPS_REQUIRED");
            this.store.put("config", "public", { provider, engineUrl: url });
          } catch {
            this.error = "TUNNEL_URL_INVALID";
            this.status = "failed";
            child.kill();
          }
        }
        if (message.type === "status" && !this.error) {
          clearTimeout(this.startupTimer);
          this.status = String(message.status);
          this.error = /^(ERR_NGROK_\d+|TUNNEL_START_FAILED)$/.test(
            message.error ?? "",
          )
            ? message.error
            : undefined;
        }
      });
      child.on("error", () => {
        if (this.child !== child) return;
        clearTimeout(this.startupTimer);
        this.status = "failed";
        this.error = "TUNNEL_START_FAILED";
      });
      child.once("exit", () => {
        if (this.child === child) {
          clearTimeout(this.startupTimer);
          this.child = undefined;
          if (this.status !== "stopped") {
            this.status = "failed";
            this.error ??= "TUNNEL_START_FAILED";
          }
        }
      });
      child.send({
        provider,
        directory: installation.directory,
        secret,
        engineUrl,
        ports,
      });
    } catch (error) {
      this.status = "failed";
      this.error =
        error instanceof HttpError ? error.message : "TUNNEL_START_FAILED";
      throw error instanceof HttpError ? error : new HttpError(502, this.error);
    } finally {
      this.starting = false;
    }
  }
  stop() {
    clearTimeout(this.startupTimer);
    this.child?.kill();
    this.child = undefined;
    this.status = "stopped";
  }
  async diagnose() {
    const config =
      this.store.get<Record<string, string>>("config", "public") ?? {};
    const checks = await Promise.all(
      ["engine", "preview"].map(async (key) => {
        try {
          const url = endpoint(config.engineUrl);
          if (url.protocol !== "https:") throw new Error("HTTPS_REQUIRED");
          const response = await fetch(
            url.origin + (key === "engine" ? "/health" : "/preview/"),
            { redirect: "error", signal: AbortSignal.timeout(10000) },
          );
          return {
            check: key,
            ok: key === "engine" ? response.ok : response.status === 410,
          };
        } catch {
          return { check: key, ok: false };
        }
      }),
    );
    const websocket = await new Promise<boolean>((resolve) => {
      let socket: WebSocket;
      try {
        const url = endpoint(config.engineUrl);
        url.pathname = "/connect";
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        socket = new WebSocket(url, { handshakeTimeout: 10000 });
      } catch {
        resolve(false);
        return;
      }
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        socket.terminate();
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 10000);
      socket.once("message", (data) => {
        try {
          const value = JSON.parse(data.toString());
          finish(value.v === 1 && value.type === "challenge");
        } catch {
          finish(false);
        }
      });
      socket.once("error", () => finish(false));
    });
    checks.push({ check: "websocket", ok: websocket });
    return {
      checks,
      websocket: websocket
        ? "WSS protocol challenge received"
        : "WSS connection failed",
      activity: "Confirm inside the plugin using a linked member",
      externalDevice: "Confirm from a different network",
    };
  }
}
