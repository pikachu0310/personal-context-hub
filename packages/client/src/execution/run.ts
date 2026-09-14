import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import type { Mapping } from "@ido/common/contracts/protocol";
import { run, workerEnvironment } from "@ido/common/runtime/platform";
import { restrictExecutionPolicy } from "@ido/common/contracts/work";

import { codexBinary } from "../codex/binary.js";
import type { Executor, Run } from "../execution/executor.js";
export async function execute(
  this: Executor,
  value: Run,
  mapping: Mapping,
  create: boolean,
) {
  const repository = await realpath(mapping.directory);
  if (value.state === "cancelled") return;
  const codex = this.createCodex({
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
    const policy = restrictExecutionPolicy(
      value.task.executionPolicy,
      value.task.effectiveExecutionPolicy,
      value.effectiveExecutionPolicy,
    );
    const options = {
      workingDirectory: value.directory,
      sandboxMode: policy.sandboxMode ?? "workspace-write",
      requireWritableSandbox: policy.sandboxMode !== "read-only",
      networkAccessEnabled:
        mapping.network &&
        value.task.network &&
        policy.networkAccessEnabled !== false,
      approvalPolicy: "on-request",
      webSearchMode: "disabled",
    };
    value.effectiveExecutionPolicy = {
      sandboxMode: options.sandboxMode,
      networkAccessEnabled: options.networkAccessEnabled,
    };
    value.activeSpecRevision ??= value.task.specRevision ?? 1;
    await this.save();
    active.thread = value.threadId
      ? codex.resumeThread(value.threadId, options)
      : codex.startThread(options);
    value.state = "running";
    await this.save();
    this.report(value);
    const prompt = [
      !create
        ? "同じタスクの続きです。履歴と現在の作業場所を確認し、実行済みの操作を重複させず未完了分だけ進めてください。"
        : "",
      options.sandboxMode === "read-only"
        ? "これは読み取り専用の調査です。ファイル変更・送信・公開・サービス操作などの外部変更は行わず、根拠と不明点を報告してください。"
        : "",
      value.task.text,
    ]
      .filter(Boolean)
      .join("\n\n");
    const { events } = await active.thread.runStreamed(prompt, {
      signal: abort.signal,
    });
    let completed = false;
    for await (const event of events) {
      if (event.type === "turn.completed") completed = true;
      if (event.type === "turn.started") await this.deliverInstructions(value);
      if (event.type === "thread.started") {
        value.threadId = event.thread_id;
        await this.save();
      } else if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        event.item.phase !== "commentary"
      )
        value.result = event.item.text;
      else if (event.type === "turn.failed" || event.type === "error")
        throw new Error("CODEX_TURN_FAILED");
      value.progress = event.type;
      this.report(value);
    }
    await this.steering.get(value.task.runId);
    if (!abort.signal.aborted && (!completed || !value.result?.trim()))
      throw new Error("CODEX_TASK_INCOMPLETE");
    value.state = abort.signal.aborted
      ? "cancelled"
      : value.instructions?.some(
            (instruction) => instruction.delivery === "uncertain",
          )
        ? "interrupted"
        : "completed";
    await this.save();
    this.report(value);
  } finally {
    this.active.delete(value.task.runId);
    await codex.close();
  }
}
