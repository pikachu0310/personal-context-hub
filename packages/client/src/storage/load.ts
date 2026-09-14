import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { json } from "@ido/common/runtime/platform";

import type { Executor, Run } from "../execution/executor.js";
import { recordActivity } from "../execution/activity.js";
export async function load(this: Executor) {
  await mkdir(this.home, { recursive: true, mode: 0o700 });
  const saved = await json<{ runs: Record<string, Run>; commands: string[] }>(
    join(this.directory, "runs.json"),
    { runs: {}, commands: [] },
  );
  this.runs = saved.runs;
  this.commands = saved.commands;
  for (const value of Object.values(this.runs)) {
    value.instructions ??= [];
    // Legacy string journals cannot prove whether a steer was delivered.
    for (const [index, text] of (value.pendingInstructions ?? []).entries())
      value.instructions.push({
        id: `${value.task.runId}:legacy:${index}`,
        text,
        specRevision: value.task.specRevision ?? 1,
        delivery: "uncertain",
      });
    delete value.pendingInstructions;
    for (const instruction of value.instructions)
      if (instruction.delivery === "sending")
        instruction.delivery = "uncertain";
    for (const receipt of Object.values(value.controlReceipts ?? {}))
      if (
        receipt.delivery === "pending" ||
        value.instructions.some(
          (instruction) =>
            instruction.receiptId === receipt.id &&
            instruction.delivery === "uncertain",
        )
      )
        receipt.delivery = "uncertain";
    if (["running", "assigned"].includes(value.state)) {
      value.state = "interrupted";
      value.progress =
        "Client restarted. Explicit retry is required; the worktree is preserved.";
      for (const entry of value.activity ?? [])
        if (["running", "in_progress"].includes(entry.status ?? ""))
          entry.status = "interrupted";
      recordActivity(value, {
        kind: "status",
        title: "アプリ再起動により中断",
        text: "作業フォルダーと履歴は保持しています。再実行には明示的な操作が必要です。",
        status: "interrupted",
      });
    }
  }
  await this.save();
}
