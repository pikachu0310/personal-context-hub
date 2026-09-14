import { purge } from "./purge.js";
import { join } from "node:path";
import type {
  ClientActivity,
  TaskContextSource,
} from "@ido/common/contracts/api";
import { executionError, recordActivity } from "./activity.js";
import { waitForPlan, startPlannedWork } from "./planning.js";
import type { Command, Mapping, Task } from "@ido/common/contracts/protocol";
import { approve } from "../approvals/resolve.js";
import { artifact } from "../artifacts/diff.js";
import { AppServerCodex } from "../codex/app-server.mjs";
import { load } from "../storage/load.js";
import { save } from "../storage/save.js";
import { execute } from "./run.js";
import type { AgentKind } from "../agents/types.js";
import { ClaudeRuntime } from "../agents/claude.js";
import {
  normalizeExecutionPolicy,
  restrictExecutionPolicy,
  type ExecutionPolicy,
  type ClientControlReceipt,
  type ControlDelivery,
} from "@ido/common/contracts/work";

export interface WorkInstruction {
  id: string;
  receiptId?: string;
  controlVersion?: number;
  specRevision: number;
  text: string;
  delivery: "pending" | "sending" | "accepted" | "uncertain";
}

export interface Run {
  contextSources?: TaskContextSource[];
  model?: string;
  reasoningEffort?: string;
  agent?: AgentKind;
  origin?: "local";
  localMapping?: Mapping;
  discordShare?: {
    engineUrl: string;
    deviceId: string;
    projectId: string;
    sequence: number;
    taskId?: string;
    fingerprint?: string;
    status?: "pending" | "synced" | "error";
    error?: string;
  };
  accessMode?: "full" | "approval";
  progressMode?: "auto" | "manual";
  pendingProgressMode?: "auto" | "manual";
  phase?: "planning" | "awaiting-plan" | "executing";
  planApproved?: boolean;
  plan?: string;
  activity?: ClientActivity[];
  activityDropped?: number;
  activityVersion?: number;
  updatedAt?: number;
  task: Task;
  directory: string;
  threadId?: string;
  state: Task["state"];
  result?: string;
  progress?: string;
  pendingInstructions?: string[];
  instructions?: WorkInstruction[];
  activeSpecRevision?: number;
  effectiveExecutionPolicy?: ExecutionPolicy;
  controlReceipts?: Record<string, ClientControlReceipt>;
}
export { codexBinary } from "../codex/binary.js";
export class Executor {
  contextProfile: () => { name: string; context: string } | undefined = () =>
    undefined;
  createClaude = (options: ConstructorParameters<typeof ClaudeRuntime>[0]) =>
    new ClaudeRuntime(options);
  planWaiters = new Map<string, (choice: "discuss" | "execute") => void>();
  readonly waitForPlan = waitForPlan.bind(this);
  readonly startPlannedWork = startPlannedWork.bind(this);
  runs: Record<string, Run> = {};
  commands: string[] = [];
  deletedTasks: Record<string, true> = {};
  pendingPurges: Record<string, string[]> = {};
  readonly purge = purge.bind(this);
  running = new Map<string, Promise<void>>();
  steering = new Map<string, Promise<void>>();
  active = new Map<
    string,
    { thread: any; codex: { close(): Promise<void> }; abort: AbortController }
  >();
  approvals = new Map<
    string,
    {
      runId?: string;
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
    readonly createCodex: (options: any) => AppServerCodex = (options) =>
      new AppServerCodex(options),
  ) {}
  get home() {
    return join(this.directory, "codex");
  }
  readonly load = load.bind(this);
  readonly save = save.bind(this);
  report(value: Run) {
    if (value.origin === "local" || this.deletedTasks[value.task.id]) return;
    this.emit({
      v: 1,
      type: "result",
      taskId: value.task.id,
      runId: value.task.runId,
      revision: value.task.revision,
      state: value.state,
      result: value.result,
      progress: value.progress,
      specRevision: value.activeSpecRevision ?? value.task.specRevision ?? 1,
      effectiveExecutionPolicy: value.effectiveExecutionPolicy,
      controlReceipts: Object.values(value.controlReceipts ?? {}).slice(-100),
    });
  }
  readonly artifact = artifact.bind(this);
  async receive(
    command: Command,
    mappings: Mapping[],
    allow: boolean,
    slots: number,
    local?: {
      discordShare?: Run["discordShare"];
      accessMode?: "full" | "approval";
      progressMode: "auto" | "manual";
      agent?: AgentKind;
      model?: string;
      reasoningEffort?: string;
    },
  ) {
    if (!command.id) throw new Error("COMMAND_ID_REQUIRED");
    if (command.type === "task.purge" && !local) {
      if (typeof command.taskId !== "string")
        throw new Error("TASK_ID_REQUIRED");
      await this.purge(command.taskId);
      this.emit({ v: 1, type: "ack", id: command.id });
      return;
    }
    if (!local && command.taskId && this.deletedTasks[command.taskId]) {
      this.emit({ v: 1, type: "ack", id: command.id });
      return;
    }
    const existing = this.runs[String(command.runId)];
    if (existing && (existing.origin === "local") !== !!local)
      throw new Error("TASK_ORIGIN_MISMATCH");
    const acknowledge = () => {
      if (!local) this.emit({ v: 1, type: "ack", id: command.id });
    };
    if (this.commands.includes(command.id)) {
      acknowledge();
      const previous = this.runs[String(command.runId)];
      if (previous) this.report(previous);
      return;
    }
    const task = command.task as Task | undefined;
    const previous = this.runs[String(command.runId)];
    if (
      previous &&
      (previous.task.id !== command.taskId ||
        (command.type !== "retry" &&
          command.revision !== undefined &&
          command.revision !== previous.task.revision))
    ) {
      this.commands.push(command.id);
      await this.save();
      acknowledge();
      this.report(previous);
      return;
    }
    if (command.type === "execute" || command.type === "retry") {
      if (!task || task.runId !== command.runId || task.id !== command.taskId)
        throw new Error("INVALID_TASK");
      task.executionPolicy = normalizeExecutionPolicy(task.executionPolicy);
      const mapping = mappings.find(
        (m) => m.projectId === task.projectId && (!task.network || m.network),
      );
      const occupied = Object.values(this.runs).filter((r) =>
        ["assigned", "running"].includes(r.state),
      );
      const ownsSlot =
        !!previous && ["assigned", "running"].includes(previous.state);
      if (
        !allow ||
        !mapping ||
        (occupied.length >= slots && !ownsSlot) ||
        (occupied.filter((r) => r.task.projectId === task.projectId).length >=
          mapping.slots &&
          !ownsSlot)
      )
        return;
      // A completed turn can still be releasing its worker when the next request arrives.
      if (
        previous &&
        command.type === "retry" &&
        task.revision > previous.task.revision &&
        this.active.has(task.runId)
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
        acknowledge();
        this.report(previous);
        return;
      }
      const directory =
        previous?.directory ?? join(this.directory, "worktrees", task.runId);
      task.attachedSources = [
        ...new Map(
          [
            ...(previous?.task.attachedSources ?? []),
            ...(task.attachedSources ?? []),
          ].map((source) => [source.id, source]),
        ).values(),
      ];
      const value: Run = {
        contextSources: previous?.contextSources?.filter(
          (source) => source.kind !== "minutes",
        ),
        agent: previous?.agent ?? local?.agent ?? "codex",
        model: previous ? previous.model : (local?.model ?? mapping.model),
        reasoningEffort: previous
          ? previous.reasoningEffort
          : local
            ? local.reasoningEffort
            : mapping.reasoningEffort,
        origin: local ? "local" : undefined,
        localMapping: local ? structuredClone(mapping) : undefined,
        discordShare: previous?.discordShare ?? local?.discordShare,
        accessMode: previous
          ? previous.accessMode
          : (local?.accessMode ?? mapping.accessMode),
        progressMode:
          previous?.pendingProgressMode ??
          previous?.progressMode ??
          local?.progressMode ??
          mapping.progressMode ??
          "auto",
        activity: structuredClone(previous?.activity ?? []),
        activityDropped: previous?.activityDropped,
        activityVersion: previous?.activityVersion,
        task: structuredClone(task),
        directory,
        threadId: previous?.threadId,
        state: "assigned",
        pendingInstructions: previous?.pendingInstructions ?? [],
        instructions: structuredClone(previous?.instructions ?? []),
        activeSpecRevision: command.continuation
          ? (task.specRevision ?? 1)
          : (previous?.activeSpecRevision ?? task.specRevision ?? 1),
        effectiveExecutionPolicy: restrictExecutionPolicy(
          previous?.effectiveExecutionPolicy,
          previous?.task.effectiveExecutionPolicy,
          previous?.task.executionPolicy,
          task.effectiveExecutionPolicy,
          task.executionPolicy,
        ),
        controlReceipts: structuredClone(previous?.controlReceipts ?? {}),
      };
      const uncertain =
        value.instructions?.filter((instruction) =>
          ["uncertain", "sending"].includes(instruction.delivery),
        ) ?? [];
      if (uncertain.length && command.instructionResolution === "retry")
        for (const instruction of uncertain) {
          instruction.delivery = "pending";
          this.controlReceipt(value, instruction, "queued");
        }
      else if (
        uncertain.length &&
        command.instructionResolution === "discard"
      ) {
        for (const instruction of uncertain)
          this.controlReceipt(value, instruction, "rejected");
        value.instructions = value.instructions?.filter(
          (instruction) => !uncertain.includes(instruction),
        );
        value.activeSpecRevision = task.specRevision ?? 1;
      } else if (uncertain.length) value.state = "interrupted";
      this.controlReceipt(
        value,
        command,
        value.state === "interrupted" ? "uncertain" : "queued",
      );
      if (typeof command.continuation === "string")
        recordActivity(value, {
          id: `continuation:${command.id}`,
          kind: "instruction",
          title: "追加依頼",
          text: command.continuation,
          status: "accepted",
        });
      this.runs[task.runId] = value;
      this.commands.push(command.id);
      await this.save();
      acknowledge();
      if (value.state === "interrupted") {
        value.progress =
          "An earlier instruction has unknown delivery. Resolve it before retrying.";
        this.report(value);
        return;
      }
      const running = this.execute(value, mapping, !previous)
        .catch(async (error) => {
          if (!["cancelled", "interrupted"].includes(value.state))
            value.state = "failed";
          value.progress = `Execution stopped or failed. Inspect the local repository and ${value.agent === "claude" ? "Claude" : "Codex"} login.`;
          recordActivity(value, {
            id: "terminal",
            kind: "status",
            title:
              value.state === "cancelled"
                ? "停止しました"
                : "実行を完了できませんでした",
            status: value.state,
            text:
              value.state === "cancelled"
                ? "停止要求を受けて実行を終了しました。"
                : executionError(error),
          });
          await this.save();
          this.report(value);
        })
        .finally(() => {
          if (this.running.get(task.runId) === running)
            this.running.delete(task.runId);
        });
      this.running.set(task.runId, running);
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
        this.controlReceipt(stopped, command, "stopped");
        this.runs[task.runId] = stopped;
        this.commands.push(command.id);
        await this.save();
        this.report(stopped);
        acknowledge();
        return;
      }
      this.commands.push(command.id);
      this.controlReceipt(previous, command, "pending");
      await this.save();
      previous.state = "cancelled";
      const current = this.active.get(previous.task.runId);
      if (current) {
        current.abort.abort();
        await current.codex.close();
      }
      await this.running.get(previous.task.runId);
      previous.state = "cancelled";
      this.controlReceipt(previous, command, "stopped");
      recordActivity(previous, {
        id: "terminal",
        kind: "status",
        title: "停止しました",
        status: "cancelled",
      });
      await this.save();
      this.report(previous);
      acknowledge();
    } else if (command.type === "steer") {
      if (!previous) return;
      if (typeof command.text !== "string" || !command.text.trim())
        throw new Error("INSTRUCTION_REQUIRED");
      const specRevision =
        Number.isSafeInteger(command.specRevision) &&
        Number(command.specRevision) > 0
          ? Number(command.specRevision)
          : (previous.task.specRevision ?? 1) + 1;
      if (specRevision < (previous.task.specRevision ?? 1))
        throw new Error("STALE_TASK_SPECIFICATION");
      this.commands.push(command.id);
      previous.task.specRevision = specRevision;
      previous.instructions ??= [];
      previous.instructions.push({
        id: command.id,
        text: command.text,
        specRevision,
        delivery: "pending",
        receiptId:
          typeof command.receiptId === "string" ? command.receiptId : undefined,
        controlVersion:
          typeof command.controlVersion === "number"
            ? command.controlVersion
            : undefined,
      });
      recordActivity(previous, {
        id: `instruction:${command.id}`,
        kind: "instruction",
        title: "追加指示",
        text: command.text,
        status: "pending",
      });
      this.controlReceipt(previous, command, "queued");
      await this.save();
      await this.deliverInstructions(previous);
      if (previous.phase === "awaiting-plan")
        this.planWaiters.get(previous.task.runId)?.("discuss");
      this.report(previous);
      acknowledge();
    }
  }
  controlReceipt(
    value: Run,
    command: { receiptId?: unknown; controlVersion?: unknown },
    delivery: ControlDelivery,
  ) {
    if (
      typeof command.receiptId !== "string" ||
      !Number.isSafeInteger(command.controlVersion)
    )
      return;
    value.controlReceipts ??= {};
    value.controlReceipts[command.receiptId] = {
      id: command.receiptId,
      controlVersion: Number(command.controlVersion),
      delivery,
    };
  }

  deliverInstructions(value: Run): Promise<void> {
    const previous = this.steering.get(value.task.runId) ?? Promise.resolve();
    const operation = previous
      .catch(() => {})
      .then(async () => {
        if (
          value.instructions?.some(
            (instruction) => instruction.delivery === "uncertain",
          )
        )
          return;
        for (const instruction of value.instructions ?? []) {
          const current = this.active.get(value.task.runId);
          if (instruction.delivery !== "pending") continue;
          if (value.state === "cancelled" || !current?.thread?.activeTurnId)
            return;
          instruction.delivery = "sending";
          try {
            await this.save();
          } catch (error) {
            instruction.delivery = "pending";
            throw error;
          }
          try {
            const applied = await current.thread.steer(instruction.text);
            instruction.delivery = applied ? "accepted" : "pending";
            recordActivity(value, {
              id: `instruction:${instruction.id}`,
              kind: "instruction",
              title: "追加指示",
              text: instruction.text,
              status: instruction.delivery,
            });
            if (applied) value.activeSpecRevision = instruction.specRevision;
            this.controlReceipt(
              value,
              instruction,
              applied ? "applied" : "queued",
            );
            value.progress = applied
              ? "Additional instruction applied."
              : "Additional instruction queued for explicit retry.";
            await this.save();
            if (!applied) return;
          } catch {
            instruction.delivery = "uncertain";
            recordActivity(value, {
              id: `instruction:${instruction.id}`,
              kind: "instruction",
              title: "追加指示",
              text: instruction.text,
              status: "uncertain",
            });
            this.controlReceipt(value, instruction, "uncertain");
            value.progress =
              "Instruction delivery is unknown; no automatic replay.";
            await this.save();
            this.report(value);
            return;
          }
        }
      });
    this.steering.set(value.task.runId, operation);
    void operation
      .finally(() => {
        if (this.steering.get(value.task.runId) === operation)
          this.steering.delete(value.task.runId);
      })
      .catch(() => {});
    return operation;
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
    await Promise.allSettled([
      ...this.running.values(),
      ...this.steering.values(),
    ]);
    await this.saving;
  }
}
