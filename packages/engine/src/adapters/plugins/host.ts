import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  PluginEvent,
  PluginFrame,
  PluginManifest,
} from "@ido/common/contracts/plugins";
import type { Credentials } from "@ido/common/runtime/credentials";
import { npmRun, run } from "@ido/common/runtime/platform";
import type { Repository } from "../../ports/repository.js";
import { PluginProcess } from "./process.js";
export interface CatalogEntry {
  id: string;
  package: string;
  version: string;
  builtin?: string;
}
export class Plugins {
  readonly processes = new Map<string, PluginProcess>();
  readonly busy = new Set<string>();
  constructor(
    readonly directory: string,
    readonly store: Repository,
    readonly credentials: Credentials,
    readonly catalog: CatalogEntry[],
    readonly request: (
      pluginId: string,
      operation: string,
      input: Record<string, unknown>,
      context?: string,
    ) => Promise<unknown>,
    readonly event: (pluginId: string, frame: PluginFrame) => void,
  ) {}
  get(id: string) {
    let plugin = this.processes.get(id);
    if (!plugin) {
      plugin = new PluginProcess(
        id,
        this.directory,
        (op, input, context) => this.request(id, op, input, context),
        (frame) => this.event(id, frame),
      );
      this.processes.set(id, plugin);
    }
    return plugin;
  }
  entry(id: string) {
    const entry = this.catalog.find((entry) => entry.id === id);
    if (!entry) throw new Error("PLUGIN_NOT_IN_CATALOG");
    const installed = this.store.get<{ directory: string }>("plugin", id);
    if (installed)
      return join(
        installed.directory,
        "node_modules",
        ...entry.package.split("/"),
        "dist",
        "index.js",
      );
    if (entry.builtin) return entry.builtin;
    throw new Error("PLUGIN_NOT_INSTALLED");
  }
  state() {
    return this.catalog.map((entry) => ({
      id: entry.id,
      version: entry.version,
      manifest: this.get(entry.id).manifest,
      installed:
        this.store.get("plugin", entry.id) ??
        (entry.builtin ? { version: entry.version, builtin: true } : undefined),
      status: this.get(entry.id).status,
      busy: this.busy.has(entry.id),
      config: this.store.get("config", entry.id) ?? {},
    }));
  }
  async inspect(id: string) {
    const plugin = this.get(id);
    if (plugin.manifest) return plugin.manifest;
    const probe = new PluginProcess(
      id,
      this.directory,
      async () => {
        throw new Error("INSPECTION_ONLY");
      },
      () => {},
    );
    try {
      plugin.manifest = await probe.launch(this.entry(id));
      return plugin.manifest;
    } finally {
      await probe.stop();
    }
  }
  async configure(id: string, values: Record<string, string>) {
    const manifest = await this.inspect(id);
    const plugin = this.get(id);
    const previous = this.store.get<Record<string, string>>("config", id) ?? {};
    const config = { ...previous };
    for (const field of manifest.fields)
      if (!field.secret && typeof values[field.key] === "string")
        config[field.key] = values[field.key];
    for (const key of ["meetingId", "projectId"])
      if (typeof values[key] === "string") config[key] = values[key];
    const probe = new PluginProcess(
      id,
      this.directory,
      async () => {
        throw new Error("INSPECTION_ONLY");
      },
      () => {},
    );
    try {
      await probe.launch(this.entry(id));
      Object.assign(
        config,
        (
          await probe.request<{ config: Record<string, string> }>("validate", {
            config,
          })
        ).config,
      );
    } finally {
      await probe.stop();
    }
    for (const field of manifest.fields)
      if (field.secret && values[field.key])
        await this.credentials.set(`${id}.${field.key}`, values[field.key]);
    this.store.put("config", id, config);
    plugin.revision++;
    if (plugin.child) {
      const runtimeConfig = { ...config };
      for (const field of manifest.fields)
        if (field.secret)
          runtimeConfig[field.key] =
            (await this.credentials.get(`${id}.${field.key}`)) ?? "";
      await plugin.request("configure", { config: runtimeConfig });
      const updated = await plugin.request<PluginManifest>("inspect");
      plugin.validateManifest(updated);
      plugin.manifest = updated;
    }
  }
  async start(id: string) {
    const plugin = this.get(id);
    const manifest = await plugin.launch(this.entry(id));
    const config = { ...this.store.get<Record<string, string>>("config", id) };
    for (const field of manifest.fields)
      if (field.secret)
        config[field.key] =
          (await this.credentials.get(`${id}.${field.key}`)) ?? "";
    try {
      await plugin.start(config);
    } catch (error) {
      await plugin.stop();
      throw error;
    }
  }
  async install(id: string, version: string, tarball?: string) {
    const entry = this.catalog.find(
      (entry) => entry.id === id && entry.version === version && !entry.builtin,
    );
    if (!entry || this.busy.has(id)) throw new Error("VERSION_NOT_IN_CATALOG");
    this.busy.add(id);
    const directory = join(this.directory, "plugins", randomUUID());
    const probe = new PluginProcess(
      id,
      this.directory,
      async () => {
        throw new Error("INSPECTION_ONLY");
      },
      () => {},
    );
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await npmRun(
        [
          "install",
          "--prefix",
          directory,
          "--omit=dev",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          tarball ?? `${entry.package}@${version}`,
        ],
        { timeout: 180000 },
      );
      const root = join(directory, "node_modules", ...entry.package.split("/"));
      const pkg = JSON.parse(
        await readFile(join(root, "package.json"), "utf8"),
      );
      if (pkg.name !== entry.package || pkg.version !== version)
        throw new Error("INVALID_PLUGIN_PACKAGE");
      await run(process.execPath, ["--check", join(root, "dist", "index.js")]);
      const manifest = await probe.launch(join(root, "dist", "index.js"));
      await probe.stop();
      await this.get(id).stop();
      this.get(id).manifest = manifest;
      this.store.put("plugin", id, {
        version,
        directory,
        previous: this.store.get("plugin", id),
      });
    } catch (error) {
      await probe.stop();
      await rm(directory, { recursive: true, force: true });
      throw error;
    } finally {
      this.busy.delete(id);
    }
  }
  publish(event: PluginEvent) {
    for (const [id, plugin] of this.processes) {
      const config = this.store.get<{ meetingId?: string }>("config", id);
      if (
        !plugin.running ||
        (config?.meetingId && config.meetingId !== event.meetingId)
      )
        continue;
      void plugin.request("event", { event }).catch(() =>
        this.store.logError(new Error("PLUGIN_DELIVERY_FAILED"), {
          source: "plugin",
          operation: "event.deliver",
          meetingId: event.meetingId,
        }),
      );
    }
  }
  async close() {
    await Promise.all(
      [...this.processes.values()].map((plugin) => plugin.stop()),
    );
  }
}
