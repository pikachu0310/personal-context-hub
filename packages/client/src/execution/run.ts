import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import type { Mapping } from "@ido/common/contracts/protocol";
import { run, workerEnvironment } from "@ido/common/runtime/platform";
import { restrictExecutionPolicy } from "@ido/common/contracts/work";

import { codexBinary } from "../codex/binary.js";
import { activityText, recordActivity, recordEvent } from "./activity.js";
import { taskContextSources, contextPrompt } from "./task-context.js";
import type { Executor, Run } from "../execution/executor.js";
export async function execute(
  this: Executor,
  value: Run,
  mapping: Mapping,
  create: boolean,
) {
  const repository = await realpath(mapping.directory);
  if (value.state === "cancelled") return;
  const createRuntime =
    value.agent === "claude" ? this.createClaude : this.createCodex;
  const codex = createRuntime({
    experimentalApi: true,
    codexPathOverride: codexBinary(),
    env: workerEnvironment(this.home),
    onApprovalRequest: (method: string, params: unknown) =>
      new Promise<{ decision: string }>((resolve) => {
        const id = randomUUID(),
          timer = setTimeout(() => {
            this.approvals.delete(id);
            resolve({ decision: "decline" });
          }, 5 * 60000);
        this.approvals.set(id, {
          runId: value.task.runId,
          method,
          params,
          resolve,
          timer,
        });
        recordActivity(value, {
          kind: "status",
          title: "操作の承認待ち",
          text: method,
          status: "pending",
        });
        void this.save().catch(() => {});
      }),
  } as any);
  const abort = new AbortController();
  const active = { thread: undefined as any, codex, abort };
  this.active.set(value.task.runId, active);
  try {
    recordActivity(value, {
      kind: "status",
      title: value.progressMode === "manual" ? "相談を開始" : "作業を開始",
      event: "started",
      requestAt: value.requestAt,
      status: "running",
    });
    await this.save();
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
    const localAccess =
      !policy.sandboxMode && policy.networkAccessEnabled !== false
        ? value.accessMode
        : undefined;
    const options = {
      model: value.model,
      reasoningEffort: value.reasoningEffort,
      workingDirectory: value.directory,
      sandboxMode: localAccess
        ? "danger-full-access"
        : (policy.sandboxMode ?? "workspace-write"),
      requireWritableSandbox:
        !localAccess && policy.sandboxMode !== "read-only",
      networkAccessEnabled:
        !!localAccess ||
        (mapping.network &&
          value.task.network &&
          policy.networkAccessEnabled !== false),
      approvalPolicy:
        localAccess === "full"
          ? "never"
          : localAccess === "approval"
            ? "untrusted"
            : "on-request",
      webSearchMode: "disabled",
    };
    value.effectiveExecutionPolicy = {
      sandboxMode: localAccess
        ? undefined
        : (policy.sandboxMode ?? "workspace-write"),
      networkAccessEnabled: options.networkAccessEnabled,
    };
    value.activeSpecRevision ??= value.task.specRevision ?? 1;
    await this.save();
    active.thread = value.threadId
      ? codex.resumeThread(value.threadId, options)
      : codex.startThread(options);
    value.state = "running";
    value.contextSources = taskContextSources(
      value.task,
      this.contextProfile(),
      value.contextSources,
    );
    await this.save();
    this.report(value);
    let prompt = [
      !create
        ? "同じタスクの続きです。履歴と現在の作業場所を確認し、実行済みの操作を重複させず未完了分だけ進めてください。"
        : "",
      options.sandboxMode === "read-only"
        ? "これは読み取り専用の調査です。ファイル変更・送信・公開・サービス操作などの外部変更は行わず、根拠と不明点を報告してください。"
        : "",
      value.task.text,
      contextPrompt(value.contextSources),
    ]
      .filter(Boolean)
      .join("\n\n");
    while (true) {
      abort.signal.throwIfAborted();
      if (value.pendingProgressMode) {
        value.progressMode = value.pendingProgressMode;
        value.pendingProgressMode = undefined;
        if (value.progressMode === "manual") value.planApproved = false;
      }
      const progressMode = value.progressMode;
      const planning = progressMode === "manual" && !value.planApproved;
      if (planning) value.plan = undefined;
      value.phase = planning ? "planning" : "executing";
      const discussion = (value.instructions ?? []).filter(
        (item) => item.delivery === "pending",
      );
      if (discussion.length && planning) {
        prompt += "\n\n" + discussion.map((item) => item.text).join("\n\n");
        for (const item of discussion) item.delivery = "sending";
      }
      await this.save();
      const { events } = await active.thread.runStreamed(prompt, {
        signal: abort.signal,
        model: value.model,
        reasoningEffort: value.reasoningEffort ?? null,
        ...(progressMode === "manual"
          ? { collaborationMode: planning ? "plan" : "default" }
          : {}),
      });
      let completed = false;
      for await (const event of events) {
        if (recordEvent(value, event)) await this.save();
        if (event.type === "turn.completed") completed = true;
        if (event.type === "turn.started")
          await this.deliverInstructions(value);
        if (event.type === "thread.started") {
          value.threadId = event.thread_id;
          for (const item of discussion)
            if (item.delivery === "sending") {
              item.delivery = "accepted";
              value.activeSpecRevision = item.specRevision;
              recordActivity(value, {
                id: `instruction-start:${item.id}`,
                kind: "status",
                title: "作業を開始",
                event: "started",
                requestAt: item.sentAt,
              });
              this.controlReceipt(value, item, "applied");
              recordActivity(value, {
                id: `instruction:${item.id}`,
                kind: "instruction",
                title: "追加指示",
                text: item.text,
                sender: item.sender,
                sentAt: item.sentAt,
                status: "accepted",
              });
            }
          await this.save();
        } else if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message" &&
          event.item.phase !== "commentary"
        ) {
          if (planning) value.plan = activityText(event.item.text);
          else value.result = event.item.text;
        } else if (event.type === "turn.failed" || event.type === "error")
          throw new Error("CODEX_TURN_FAILED");
        value.progress = event.type;
        this.report(value);
      }
      await this.steering.get(value.task.runId);
      if (
        !abort.signal.aborted &&
        (!completed || !(planning ? value.plan : value.result)?.trim())
      )
        throw new Error("CODEX_TASK_INCOMPLETE");
      if (planning && !abort.signal.aborted) {
        value.phase = "awaiting-plan";
        value.progress =
          "計画の確認待ちです。会話で調整するか、アプリで実行するを押してください。";
        recordActivity(value, {
          kind: "status",
          title: "計画の確認待ち",
          text: "相談を続けられます。実装は「実行する」を押すまで開始しません。",
        });
        await this.save();
        this.report(value);
        const choice = await this.waitForPlan(value, abort.signal);
        prompt =
          choice === "execute"
            ? "合意した計画に従って実行してください。既存の実行権限とタスクの制約を守ってください。"
            : "相談を続けます。追加指示を踏まえて計画と回答を更新してください。まだ実装は開始しないでください。";
        continue;
      }
      value.state = abort.signal.aborted
        ? "cancelled"
        : value.instructions?.some(
              (instruction) => instruction.delivery === "uncertain",
            )
          ? "interrupted"
          : "completed";
      recordActivity(value, {
        id: "terminal",
        kind: "status",
        title:
          value.state === "completed"
            ? "作業が完了しました"
            : value.state === "cancelled"
              ? "停止しました"
              : "追加指示の配送確認が必要です",
        status: value.state,
      });
      await this.save();
      this.report(value);
      break;
    }
  } finally {
    for (const [id, request] of this.approvals)
      if (request.runId === value.task.runId) {
        clearTimeout(request.timer);
        request.resolve({ decision: "decline" });
        this.approvals.delete(id);
      }
    for (const item of value.instructions ?? [])
      if (item.delivery === "sending") {
        item.delivery = "uncertain";
        this.controlReceipt(value, item, "uncertain");
      }
    this.planWaiters.delete(value.task.runId);
    this.active.delete(value.task.runId);
    await codex.close();
  }
}
