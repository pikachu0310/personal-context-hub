import { join } from "node:path";
import type {
  Command,
  Mapping,
  Task,
} from "../../../common/src/contracts/protocol.js";
import { approve } from "../approvals/resolve.js";
import { artifact } from "../artifacts/diff.js";
import { AppServerCodex } from "../codex/app-server.mjs";
import { load } from "../storage/load.js";
import { save } from "../storage/save.js";
import { execute } from "./run.js";

export interface Run {
  task: Task;
  directory: string;
  threadId?: string;
  state: Task["state"];
  result?: string;
  progress?: string;
  pendingInstructions?: string[];
}
export { codexBinary } from "../codex/binary.js";
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
  readonly load = load.bind(this);
  readonly save = save.bind(this);
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
  readonly artifact = artifact.bind(this);
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
  execute = execute.bind(this);
  readonly approve = approve.bind(this);
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
