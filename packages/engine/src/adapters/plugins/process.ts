import { fork, type ChildProcess } from "node:child_process";
import {
  PLUGIN_PROTOCOL,
  pluginFrame,
  type PluginFrame,
  type PluginManifest,
} from "../../../../common/src/contracts/plugins.js";
import { workerEnvironment } from "../../../../common/src/runtime/platform.js";
import { Rpc } from "../../../../common/src/runtime/rpc.js";
export class PluginProcess {
  child?: ChildProcess;
  rpc?: Rpc;
  generation = 0;
  revision = 0;
  status = "stopped";
  running = false;
  port?: number;
  manifest?: PluginManifest;
  constructor(
    readonly id: string,
    readonly directory: string,
    readonly handle: (
      operation: string,
      input: Record<string, unknown>,
      context?: string,
    ) => Promise<unknown>,
    readonly event: (frame: PluginFrame) => void,
  ) {}
  async launch(entry: string) {
    await this.stop();
    const generation = ++this.generation;
    this.status = "starting";
    const child = fork(entry, [], {
      env: workerEnvironment(this.directory),
      execArgv: [],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    this.child = child;
    const rpc = new Rpc((frame) => {
      if (this.child !== child || !child.connected)
        throw new Error("PLUGIN_STOPPED");
      child.send(frame);
    }, this.handle);
    this.rpc = rpc;
    child.on("message", (raw) => {
      if (this.child !== child || generation !== this.generation) return;
      try {
        const frame = pluginFrame(raw);
        if (["request", "reply"].includes(frame.type))
          void rpc.receive(frame).catch(() => void this.stop());
        else {
          if (frame.type === "invalidate") this.revision++;
          if (frame.type === "status") this.status = String(frame.status);
          this.event(frame);
        }
      } catch {
        void this.stop();
      }
    });
    child.once("error", () => {
      rpc.close();
      this.status = "failed";
    });
    child.once("exit", () => {
      rpc.close();
      if (this.child === child) {
        this.child = undefined;
        this.port = undefined;
        this.generation++;
        this.status = "stopped";
        this.running = false;
      }
    });
    try {
      const manifest = await rpc.request<PluginManifest>("inspect");
      if (manifest.id !== this.id || manifest.protocol !== PLUGIN_PROTOCOL)
        throw new Error("PLUGIN_CONTRACT_MISMATCH");
      this.validateManifest(manifest);
      this.manifest = manifest;
      return manifest;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }
  validateManifest(manifest: PluginManifest) {
    if (
      manifest.id !== this.id ||
      manifest.protocol !== PLUGIN_PROTOCOL ||
      !Array.isArray(manifest.fields) ||
      !Array.isArray(manifest.capabilities)
    )
      throw new Error("PLUGIN_CONTRACT_MISMATCH");
    const web = manifest.web;
    if (
      web &&
      (web.basePath !==
        (this.id === "dashboard" ? "/dashboard" : `/plugins/${this.id}`) ||
        !Array.isArray(web.publicPaths) ||
        web.publicPaths.some(
          (path) =>
            typeof path !== "string" ||
            !path.startsWith("/") ||
            path.startsWith("//") ||
            /[?#]/.test(path),
        ))
    )
      throw new Error("INVALID_PLUGIN_WEB_PATH");
    if (
      web?.launch &&
      (!web.publicPaths.includes(web.launch.path) ||
        !Array.isArray(web.launch.query) ||
        !web.launch.query.length ||
        web.launch.query.some((key) => typeof key !== "string" || !key))
    )
      throw new Error("INVALID_PLUGIN_WEB_PATH");
  }
  async start(config: Record<string, string>) {
    const result = await this.request<{ port?: number }>("start", { config });
    if (result?.port !== undefined) {
      if (
        !Number.isInteger(result.port) ||
        result.port < 1024 ||
        result.port > 65535
      )
        throw new Error("INVALID_PLUGIN_PORT");
      this.port = result.port;
    }
    const manifest = await this.request<PluginManifest>("inspect");
    this.validateManifest(manifest);
    this.manifest = manifest;
    this.status = "running";
    this.running = true;
  }
  request<T = unknown>(
    operation: string,
    input: Record<string, unknown> = {},
    context?: string,
  ): Promise<T> {
    if (!this.child?.connected || !this.rpc)
      return Promise.reject(new Error("PLUGIN_NOT_RUNNING"));
    return this.rpc.request<T>(operation, input, context);
  }
  async stop() {
    const child = this.child;
    this.child = undefined;
    this.generation++;
    this.port = undefined;
    this.status = "stopped";
    this.running = false;
    this.rpc?.close();
    this.rpc = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill();
    });
  }
}
