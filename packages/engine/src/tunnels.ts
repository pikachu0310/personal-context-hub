import { fork, type ChildProcess } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir } from "node:fs/promises";
import { run, npmRun, workerEnvironment } from "../../common/src/platform.js";
import { Credentials } from "../../common/src/credentials.js";
import { Store } from "./store.js";
import { endpoint } from "../../common/src/protocol.js";
import { WebSocket } from "ws";
export class Tunnels {
  child?: ChildProcess;
  status = "stopped";
  busy = false;
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
  async start(provider: string, ports: { engine: number; preview: number }) {
    const installation = this.store.get<{ directory: string }>(
      "tunnel",
      provider,
    );
    if (!installation) throw new Error("TUNNEL_NOT_INSTALLED");
    const secret = await this.credentials.get(`tunnel.${provider}`);
    if (!secret) throw new Error("TUNNEL_CREDENTIAL_REQUIRED");
    const config = this.store.get<Record<string, string>>("config", "public");
    if (!config?.engineUrl || !config.previewUrl)
      throw new Error("PUBLIC_URLS_REQUIRED");
    this.stop();
    this.status = "starting";
    const child = fork(
      join(dirname(fileURLToPath(import.meta.url)), "tunnel-worker.js"),
      [],
      {
        env: workerEnvironment(this.directory),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    this.child = child;
    child.on("message", (message: any) => {
      if (message.type === "status") this.status = String(message.status);
    });
    child.on("error", () => {
      this.status = "failed";
    });
    child.once("exit", () => {
      if (this.child === child) {
        this.child = undefined;
        this.status = "stopped";
      }
    });
    child.send({
      provider,
      directory: installation.directory,
      secret,
      engineUrl: endpoint(config.engineUrl).origin,
      previewUrl: endpoint(config.previewUrl).origin,
      ports,
    });
  }
  stop() {
    this.child?.kill();
    this.child = undefined;
    this.status = "stopped";
  }
  async diagnose() {
    const config =
      this.store.get<Record<string, string>>("config", "public") ?? {};
    const checks = await Promise.all(
      ["engineUrl", "previewUrl"].map(async (key) => {
        try {
          const url = endpoint(config[key]);
          if (url.protocol !== "https:") throw new Error("HTTPS_REQUIRED");
          const response = await fetch(
            url.origin + (key === "engineUrl" ? "/health" : "/"),
            { redirect: "error", signal: AbortSignal.timeout(10000) },
          );
          return {
            check: key,
            ok: key === "engineUrl" ? response.ok : response.status === 410,
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
      activity: "Confirm inside Discord using a linked member",
      externalDevice: "Confirm from a different network",
    };
  }
}
