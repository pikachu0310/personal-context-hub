import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import type { Mapping } from "../../../common/src/contracts/protocol.js";
import {
  run,
  workerEnvironment,
} from "../../../common/src/runtime/platform.js";
import { AppServerCodex } from "../codex/app-server.mjs";

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
      if (event.type === "turn.started" && value.pendingInstructions?.length) {
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
