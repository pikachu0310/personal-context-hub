import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { realpath } from "node:fs/promises";
import { relative, isAbsolute } from "node:path";

export function parsePreviewCommand(value) {
  if (!value?.trim()) return undefined;
  const command = JSON.parse(value);
  if (
    !Array.isArray(command) ||
    !command.length ||
    command.length > 40 ||
    command.some(
      (part) => typeof part !== "string" || !part || part.includes("\0"),
    ) ||
    !command.some((part) => part.includes("{port}"))
  )
    throw new Error(
      "Preview command must be a JSON argv array including {port}",
    );
  return command;
}

async function unusedPort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

export class TaskPreviewManager {
  constructor({
    command,
    workspaceRoot,
    codexExecutable = "codex",
    codexHome,
    ttlMs = 60 * 60_000,
    startupTimeoutMs = 30_000,
    sharedUrlTemplate,
    verify,
    onChange = async () => {},
    spawnProcess = spawn,
    fetchUrl = fetch,
  }) {
    Object.assign(this, {
      command,
      workspaceRoot,
      codexExecutable,
      codexHome,
      ttlMs,
      startupTimeoutMs,
      sharedUrlTemplate,
      verify,
      onChange,
      spawnProcess,
      fetchUrl,
    });
    this.entries = new Map();
    this.stopping = new Map();
    this.usedPorts = new Set();
    this.closed = false;
    if (sharedUrlTemplate) {
      const url = new URL(sharedUrlTemplate.replaceAll("{port}", "12345"));
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        !sharedUrlTemplate.includes("{port}")
      )
        throw new Error(
          "Shared preview URL must be an http(s) URL template including {port}, without credentials",
        );
    }
  }

  async start(task, { signal } = {}) {
    if (
      !this.command ||
      !task.workingDirectory ||
      !task.runRevision ||
      this.closed
    )
      return undefined;
    await this.stop(task.id, "superseded");
    if (this.closed) return undefined;
    signal?.throwIfAborted();
    const root = await realpath(this.workspaceRoot);
    const cwd = await realpath(task.workingDirectory);
    const rel = relative(root, cwd);
    if (!rel || rel.startsWith("..") || isAbsolute(rel))
      throw new Error(
        "Preview workspace must belong to the configured task root",
      );
    let port = await unusedPort();
    while (this.usedPorts.has(port)) port = await unusedPort();
    this.usedPorts.add(port);
    if (this.closed) return undefined;
    signal?.throwIfAborted();
    const preview = {
      state: "starting",
      runRevision: task.runRevision,
      specRevision: task.activeSpecRevision ?? 1,
      url: `http://127.0.0.1:${port}/`,
      startedAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      sharedUrl: this.sharedUrlTemplate?.replaceAll("{port}", String(port)),
      confirmations: [],
      browserVerified: false,
      reachability: "local-only",
    };
    task.preview = preview;
    // The command comes from the operator's environment, not generated task
    // files. Keep server credentials out and preserve worker write isolation.
    const child = this.spawnProcess(
      this.codexExecutable,
      [
        "sandbox",
        "-P",
        "idd-preview",
        "-C",
        cwd,
        "-c",
        'permissions.idd-preview.extends=":workspace"',
        "-c",
        "permissions.idd-preview.network.enabled=true",
        "--",
        ...this.command.map((part) => part.replaceAll("{port}", String(port))),
      ],
      {
        cwd,
        detached: process.platform !== "win32",
        windowsHide: true,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...(this.codexHome ? { CODEX_HOME: this.codexHome } : {}),
          NODE_ENV: "development",
          PORT: String(port),
          HOST: "127.0.0.1",
        },
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const entry = { child, task, preview };
    this.entries.set(task.id, entry);
    child.once("error", () => {
      preview.state = "failed";
      void Promise.resolve(this.onChange(task)).catch(() => {});
    });
    child.once("exit", () => {
      clearTimeout(entry.timer);
      if (["starting", "available"].includes(preview.state)) {
        preview.state = "stopped";
        void Promise.resolve(this.onChange(task)).catch(() => {});
      }
    });
    const abort = () => {
      void this.stop(task.id, "stopped");
    };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      while (
        Date.now() - preview.startedAt < this.startupTimeoutMs &&
        preview.state === "starting"
      ) {
        signal?.throwIfAborted();
        try {
          const response = await this.fetchUrl(preview.url, {
            redirect: "error",
            signal: AbortSignal.timeout(1000),
          });
          await response.body?.cancel();
          if (response.ok) {
            preview.state = "available";
            break;
          }
        } catch {
          /* A dev server may still be starting. */
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      signal?.throwIfAborted();
      if (preview.state !== "available") {
        await this.stop(task.id, "failed");
        return preview;
      }
      if (this.verify) {
        try {
          const result = await this.verify({ url: preview.url, task, signal });
          preview.browserVerified = result?.passed === true;
          preview.verification = String(result?.summary ?? "").slice(0, 500);
        } catch {
          preview.verification = "ブラウザ操作の確認に失敗しました";
        }
      }
      if (
        this.closed ||
        preview.specRevision !== (task.specRevision ?? 1) ||
        preview.state !== "available"
      ) {
        await this.stop(task.id, "superseded");
        return preview;
      }
      if (preview.sharedUrl) preview.reachability = "participant-check-pending";
      entry.timer = setTimeout(
        () => {
          void this.stop(task.id, "expired");
        },
        Math.max(1, preview.expiresAt - Date.now()),
      );
      entry.timer.unref?.();
      await this.onChange(task);
      return preview;
    } finally {
      signal?.removeEventListener("abort", abort);
    }
  }

  async confirm(task, revision, userId) {
    const entry = this.entries.get(task.id);
    const preview = entry?.preview;
    if (
      !userId ||
      !preview ||
      preview.state !== "available" ||
      preview.runRevision !== revision ||
      task.runRevision !== revision ||
      preview.specRevision !== (task.specRevision ?? 1)
    )
      return false;
    if (!preview.confirmations.some((item) => item.userId === userId))
      preview.confirmations.push({
        userId,
        at: Date.now(),
        runRevision: revision,
      });
    // This is a participant's explicit report of trying the version, not an
    // automatic inference from HTTP status or a passed build.
    preview.reachability =
      preview.confirmations.length >= 4
        ? "four-participants-confirmed"
        : "participant-check-pending";
    await this.onChange(task);
    return true;
  }

  async stop(taskId, state = "stopped") {
    if (this.stopping.has(taskId)) return this.stopping.get(taskId);
    const operation = this.stopEntry(taskId, state).finally(() =>
      this.stopping.delete(taskId),
    );
    this.stopping.set(taskId, operation);
    return operation;
  }

  async stopEntry(taskId, state) {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    this.entries.delete(taskId);
    clearTimeout(entry.timer);
    entry.preview.state = state;
    const child = entry.child;
    const kill = (signal) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          /* Already exited. */
        }
      }
      child.kill(signal);
    };
    if (child.exitCode === null && child.signalCode === null) {
      let ended = false;
      const exited = new Promise((resolve) =>
        child.once("close", () => {
          ended = true;
          resolve();
        }),
      );
      kill("SIGTERM");
      const timer = setTimeout(() => kill("SIGKILL"), 2000);
      let bounded;
      await Promise.race([
        exited,
        new Promise((resolve) => {
          bounded = setTimeout(resolve, 2500);
        }),
      ]);
      clearTimeout(timer);
      clearTimeout(bounded);
      if (!ended) {
        entry.preview.state = "stop-unconfirmed";
        this.entries.set(taskId, entry);
        await this.onChange(entry.task);
        throw new Error("Preview process termination was not confirmed");
      }
    }
    await this.onChange(entry.task);
  }

  async close() {
    this.closed = true;
    await Promise.all(
      [...this.entries.keys()]
        .map((id) => this.stop(id))
        .concat([...this.stopping.values()]),
    );
  }
}

export function formatTaskPreview(preview) {
  if (!preview) return "試用: 起動設定なし";
  if (preview.state !== "available")
    return `試用: ${{ starting: "起動中", expired: "期限切れ", superseded: "訂正前の版・停止済み", stopped: "停止済み", failed: "起動失敗", "stop-unconfirmed": "停止結果を確認できません", "restart-unverified": "再起動後の起動状態は未確認" }[preview.state] ?? preview.state}`;
  return [
    `試用版 r${preview.runRevision} / 仕様 v${preview.specRevision}: ${preview.sharedUrl ?? preview.url}`,
    `操作確認: ${preview.browserVerified ? "自動操作を確認" : "未確認"} · 人の試用報告 ${preview.confirmations?.length ?? 0}/4`,
    preview.reachability === "four-participants-confirmed"
      ? "4人がこの版を試用したと報告済み"
      : preview.sharedUrl
        ? "共有URL: 各端末での到達・試用は未確認"
        : "このPC向けのURLです。別端末からの試用は未確認",
  ].join("\n");
}
