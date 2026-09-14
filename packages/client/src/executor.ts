import { mkdir, realpath, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { AppServerCodex } from "./app-server.mjs";
import {
  atomic,
  json,
  run,
  workerEnvironment,
} from "../../common/src/platform.js";
import type { Mapping, Task, Command } from "../../common/src/protocol.js";

export interface Run {
  task: Task;
  directory: string;
  threadId?: string;
  state: Task["state"];
  result?: string;
  progress?: string;
  pendingInstructions?: string[];
}
export function codexBinary() {
  const require = createRequire(import.meta.url);
  const cpu = { x64: "x86_64", arm64: "aarch64" }[
    process.arch as "x64" | "arm64"
  ];
  const target = {
    darwin: "apple-darwin",
    linux: "unknown-linux-musl",
    win32: "pc-windows-msvc",
  }[process.platform as "darwin" | "linux" | "win32"];
  if (!cpu || !target) throw new Error("UNSUPPORTED_PLATFORM");
  return join(
    dirname(
      require.resolve(
        `@openai/codex-${process.platform}-${process.arch}/package.json`,
      ),
    ),
    "vendor",
    `${cpu}-${target}`,
    "bin",
    process.platform === "win32" ? "codex.exe" : "codex",
  );
}
export class Executor {
  runs: Record<string, Run> = {};
  commands: string[] = [];
  active = new Map<
    string,
    { thread: any; codex: AppServerCodex; abort: AbortController }
  >();
  approvals = new Map<
    string,
    {
      method: string;
      params: unknown;
      resolve: (value: { decision: string }) => void;
      timer: NodeJS.Timeout;
    }
  >();
  saving: Promise<unknown> = Promise.resolve();
  constructor(
    readonly directory: string,
    readonly emit: (message: Command) => void,
  ) {}
  get home() {
    return join(this.directory, "codex");
  }
  async load() {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const saved = await json<{ runs: Record<string, Run>; commands: string[] }>(
      join(this.directory, "runs.json"),
      { runs: {}, commands: [] },
    );
    this.runs = saved.runs;
    this.commands = saved.commands;
    for (const value of Object.values(this.runs))
      if (["running", "assigned"].includes(value.state)) {
        value.state = "interrupted";
        value.progress =
          "Client restarted. Explicit retry is required; the worktree is preserved.";
      }
    await this.save();
  }
  save() {
    const snapshot = JSON.parse(
      JSON.stringify({ runs: this.runs, commands: this.commands }),
    );
    this.saving = this.saving.then(() =>
      atomic(join(this.directory, "runs.json"), snapshot),
    );
    return this.saving;
  }
  report(value: Run) {
    this.emit({
      v: 1,
      type: "result",
      taskId: value.task.id,
      runId: value.task.runId,
      revision: value.task.revision,
      state: value.state,
      result: value.result,
      progress: value.progress,
    });
  }
  async artifact(runId: string) {
    const value = this.runs[runId];
    if (!value) throw new Error("RUN_NOT_FOUND");
    let patch = await run("git", [
      "-C",
      value.directory,
      "diff",
      "HEAD",
      "--",
      ".",
      ":(exclude).env*",
      ":(exclude)auth.json",
      ":(exclude)secrets*",
      ":(exclude)*.pem",
      ":(exclude)*.key",
      ":(exclude)**/.env*",
      ":(exclude)**/auth.json",
      ":(exclude)**/secrets*",
      ":(exclude)**/*.pem",
      ":(exclude)**/*.key",
    ]);
    const untracked = await run("git", [
      "-C",
      value.directory,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ]);
    const root = await realpath(value.directory);
    for (const path of untracked.split("\0").filter(Boolean).slice(0, 100)) {
      if (
        /(^|\/)(?:\.env[^/]*|auth\.json|secrets[^/]*|[^/]*\.(?:pem|key))$/i.test(
          path,
        )
      )
        continue;
      const target = await realpath(join(root, path));
      if (
        !target.startsWith(root + (process.platform === "win32" ? "\\" : "/"))
      )
        continue;
      const contents = await readFile(target);
      if (contents.length > 256000 || contents.includes(0)) continue;
      const lines = contents.toString().split("\n");
      patch += `\ndiff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => "+" + line).join("\n")}\n`;
      if (patch.length > 900000) break;
    }
    return {
      patch: patch.slice(0, 256000),
      branch: `ido/${runId}`,
      revision: value.task.revision,
    };
  }
  async receive(
    command: Command,
    mappings: Mapping[],
    allow: boolean,
    slots: number,
  ) {
    if (!command.id) throw new Error("COMMAND_ID_REQUIRED");
    if (this.commands.includes(command.id)) {
      this.emit({ v: 1, type: "ack", id: command.id });
      const previous = this.runs[String(command.runId)];
      if (previous) this.report(previous);
      return;
    }
    const task = command.task as Task | undefined;
    const previous = this.runs[String(command.runId)];
    if (command.type === "execute" || command.type === "retry") {
      if (!task || task.runId !== command.runId || task.id !== command.taskId)
        throw new Error("INVALID_TASK");
      const mapping = mappings.find(
        (m) => m.projectId === task.projectId && (!task.network || m.network),
      );
      const occupied = Object.values(this.runs).filter((r) =>
        ["assigned", "running"].includes(r.state),
      );
      if (
        !allow ||
        !mapping ||
        (occupied.length >= slots && !previous) ||
        (occupied.filter((r) => r.task.projectId === task.projectId).length >=
          mapping.slots &&
          !previous)
      )
        return;
      if (
        previous &&
        (command.type === "execute" ||
          this.active.has(task.runId) ||
          task.revision <= previous.task.revision)
      ) {
        this.commands.push(command.id);
        await this.save();
        this.emit({ v: 1, type: "ack", id: command.id });
        this.report(previous);
        return;
      }
      const directory =
        previous?.directory ?? join(this.directory, "worktrees", task.runId);
      const value: Run = {
        task,
        directory,
        threadId: previous?.threadId,
        state: "assigned",
        pendingInstructions: previous?.pendingInstructions ?? [],
      };
      this.runs[task.runId] = value;
      this.commands.push(command.id);
      await this.save();
      this.emit({ v: 1, type: "ack", id: command.id });
      void this.execute(value, mapping, !previous).catch(async () => {
        if (value.state !== "cancelled") value.state = "failed";
        value.progress =
          "Execution stopped or failed. Inspect the local repository and Codex login.";
        await this.save();
        this.report(value);
      });
    } else if (command.type === "stop") {
      if (!previous) {
        const task = command.task as Task | undefined;
        if (!task || task.id !== command.taskId || task.runId !== command.runId)
          return;
        const stopped: Run = {
          task,
          directory: join(this.directory, "worktrees", task.runId),
          state: "cancelled",
        };
        this.runs[task.runId] = stopped;
        this.commands.push(command.id);
        await this.save();
        this.report(stopped);
        this.emit({ v: 1, type: "ack", id: command.id });
        return;
      }
      this.commands.push(command.id);
      await this.save();
      const current = this.active.get(previous.task.runId);
      if (current) {
        current.abort.abort();
        await current.codex.close();
      }
      previous.state = "cancelled";
      await this.save();
      this.report(previous);
      this.emit({ v: 1, type: "ack", id: command.id });
    } else if (command.type === "steer") {
      if (!previous) return;
      const current = this.active.get(previous.task.runId);
      // Journal the instruction before delivery. An ambiguous crash is surfaced rather than replayed.
      this.commands.push(command.id);
      previous.pendingInstructions ??= [];
      previous.pendingInstructions.push(String(command.text));
      await this.save();
      const applied = current?.thread?.activeTurnId
        ? await current.thread.steer(String(command.text))
        : false;
      if (applied) previous.pendingInstructions.pop();
      previous.progress = applied
        ? "Additional instruction applied."
        : "Additional instruction queued for this worktree. If the turn has ended, retry explicitly.";
      await this.save();
      this.report(previous);
      this.emit({ v: 1, type: "ack", id: command.id });
    }
  }
  async execute(value: Run, mapping: Mapping, create: boolean) {
    const repository = await realpath(mapping.directory);
    if (value.state === "cancelled") return;
    const codex = new AppServerCodex({
      codexPathOverride: codexBinary(),
      env: workerEnvironment(this.home),
      onApprovalRequest: (method: string, params: unknown) =>
        new Promise<{ decision: string }>((resolve) => {
          const id = randomUUID(),
            timer = setTimeout(() => {
              this.approvals.delete(id);
              resolve({ decision: "decline" });
            }, 5 * 60000);
          this.approvals.set(id, { method, params, resolve, timer });
        }),
    } as any);
    const abort = new AbortController();
    const active = { thread: undefined as any, codex, abort };
    this.active.set(value.task.runId, active);
    try {
      if (create) {
        await mkdir(dirname(value.directory), { recursive: true, mode: 0o700 });
        await run("git", [
          "-C",
          repository,
          "worktree",
          "add",
          "-b",
          `ido/${value.task.runId}`,
          value.directory,
          "HEAD",
        ]);
      }
      const options = {
        workingDirectory: value.directory,
        sandboxMode: "workspace-write",
        requireWritableSandbox: true,
        networkAccessEnabled: mapping.network && value.task.network,
        approvalPolicy: "on-request",
        webSearchMode: "disabled",
      };
      active.thread = value.threadId
        ? codex.resumeThread(value.threadId, options)
        : codex.startThread(options);
      value.state = "running";
      await this.save();
      this.report(value);
      const { events } = await active.thread.runStreamed(value.task.text, {
        signal: abort.signal,
      });
      for await (const event of events) {
        if (
          event.type === "turn.started" &&
          value.pendingInstructions?.length
        ) {
          for (const instruction of [...value.pendingInstructions])
            if (await active.thread.steer(instruction)) {
              value.pendingInstructions.shift();
              await this.save();
            }
        }
        if (event.type === "thread.started") {
          value.threadId = event.thread_id;
          await this.save();
        } else if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message"
        )
          value.result = event.item.text;
        else if (event.type === "turn.failed")
          throw new Error("CODEX_TURN_FAILED");
        value.progress = event.type;
        this.report(value);
      }
      value.state = abort.signal.aborted ? "cancelled" : "completed";
      await this.save();
      this.report(value);
    } finally {
      this.active.delete(value.task.runId);
      await codex.close();
    }
  }
  approve(id: string, allow: boolean) {
    const request = this.approvals.get(id);
    if (!request) throw new Error("APPROVAL_EXPIRED");
    clearTimeout(request.timer);
    this.approvals.delete(id);
    request.resolve({ decision: allow ? "accept" : "decline" });
  }
  async close() {
    for (const request of this.approvals.values()) {
      clearTimeout(request.timer);
      request.resolve({ decision: "decline" });
    }
    for (const value of this.active.values()) {
      value.abort.abort();
      await value.codex.close();
    }
    await this.saving;
  }
}
