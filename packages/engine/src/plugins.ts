import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { mkdir, rename, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { RELEASE, discordManifest } from "../../common/src/protocol.js";
import { run, npmRun, workerEnvironment } from "../../common/src/platform.js";
import { HttpError } from "../../common/src/http.js";
import { Store } from "./store.js";
import { Credentials } from "../../common/src/credentials.js";

export class Plugins {
  child?: ChildProcess;
  status = "stopped";
  voiceChannelId?: string;
  busy = false;
  pending = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  constructor(
    readonly directory: string,
    readonly store: Store,
    readonly credentials: Credentials,
    readonly input: (event: Record<string, unknown>) => Promise<void>,
  ) {}
  state() {
    return {
      manifest: discordManifest,
      installed: this.store.get("plugin", "discord"),
      status: this.status,
      voiceChannelId: this.voiceChannelId,
      busy: this.busy,
    };
  }
  async install(version = RELEASE, localTarball?: string) {
    if (version !== RELEASE || this.busy)
      throw new Error("VERSION_NOT_IN_CATALOG");
    this.busy = true;
    const directory = join(this.directory, "plugins", randomUUID());
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const npm = process.platform === "win32" ? "npm.cmd" : "npm";
      // Package source is fixed by the catalog. Local tarballs are available only to the CLI for release validation.
      await npmRun(
        [
          "install",
          "--prefix",
          directory,
          "--omit=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          localTarball ?? `@ido/plugin-discord@${version}`,
        ],
        { timeout: 180000 },
      );
      const root = join(directory, "node_modules", "@ido", "plugin-discord");
      const pkg = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
      );
      if (pkg.name !== "@ido/plugin-discord" || pkg.version !== version)
        throw new Error("INVALID_PLUGIN_PACKAGE");
      await readFile(join(root, "dist", "index.js"));
      await run(process.execPath, ["--check", join(root, "dist", "index.js")]);
      await new Promise<void>((resolve, reject) => {
        const probe = fork(join(root, "dist", "index.js"), [], {
          env: workerEnvironment(this.directory),
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        });
        const timer = setTimeout(() => {
          probe.kill();
          reject(new Error("PLUGIN_CONTRACT_TIMEOUT"));
        }, 10000);
        probe.once("message", (message: any) => {
          clearTimeout(timer);
          probe.kill();
          message?.manifest?.protocol === 1 &&
          message?.manifest?.id === "discord"
            ? resolve()
            : reject(new Error("PLUGIN_CONTRACT_MISMATCH"));
        });
        probe.once("error", () => {
          clearTimeout(timer);
          reject(new Error("PLUGIN_LOAD_FAILED"));
        });
        probe.send({ type: "inspect", v: 1 });
      });
      const old = this.store.get("plugin", "discord");
      this.stop();
      this.store.put("plugin", "discord", {
        version,
        directory,
        previous: old,
      });
      this.status = "installed";
    } catch (e) {
      await rm(directory, { recursive: true, force: true });
      throw e;
    } finally {
      this.busy = false;
    }
  }
  async start() {
    const installation = this.store.get<{ directory: string }>(
      "plugin",
      "discord",
    );
    if (!installation) throw new Error("PLUGIN_NOT_INSTALLED");
    const config =
      this.store.get<Record<string, string>>("config", "discord") ?? {};
    const botToken = await this.credentials.get("discord.botToken");
    if (!botToken || !config.guildId || !config.textChannelId)
      throw new Error("DISCORD_CONFIG_REQUIRED");
    this.stop();
    this.status = "starting";
    const child = fork(
      join(
        installation.directory,
        "node_modules",
        "@ido",
        "plugin-discord",
        "dist",
        "index.js",
      ),
      [],
      {
        env: workerEnvironment(this.directory),
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );
    this.child = child;
    child.on("message", (message: unknown) => {
      if (this.child !== child || !message || typeof message !== "object")
        return;
      const event = message as Record<string, unknown>;
      if (event.type === "reply") {
        const pending = this.pending.get(String(event.id));
        if (pending) {
          clearTimeout(pending.timer);
          this.pending.delete(String(event.id));
          event.error
            ? pending.reject(
                new HttpError(502, "DISCORD_TOKEN_EXCHANGE_FAILED"),
              )
            : pending.resolve(event.result);
        }
        return;
      }
      if (event.type === "voice") {
        this.voiceChannelId =
          typeof event.channelId === "string" &&
          /^\d{1,24}$/.test(event.channelId)
            ? event.channelId
            : undefined;
      } else if (event.type === "status") this.status = String(event.status);
      else if (event.type === "input")
        void this.input(event).catch(() => {
          this.status = "input-error";
        });
    });
    child.once("error", () => {
      this.status = "failed";
    });
    child.once("exit", () => {
      if (this.child === child) {
        this.child = undefined;
        this.voiceChannelId = undefined;
        this.status = "stopped";
      }
    });
    child.send({ type: "start", v: 1, config: { ...config, botToken } });
  }
  deliver(channelId: string, content: string, audio?: string) {
    this.child?.send({ type: "output", channelId, content, audio });
  }
  request(operation: string, input: Record<string, unknown>): Promise<any> {
    if (!this.child?.connected)
      return Promise.reject(new HttpError(503, "DISCORD_PLUGIN_NOT_RUNNING"));
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HttpError(504, "DISCORD_PLUGIN_TIMEOUT"));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.send({ type: "request", v: 1, id, operation, input });
    });
  }
  stop() {
    this.voiceChannelId = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("PLUGIN_STOPPED"));
    }
    this.pending.clear();
    this.child?.kill();
    this.child = undefined;
    this.status = "stopped";
  }
}
