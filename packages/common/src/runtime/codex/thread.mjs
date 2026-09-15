import { EventQueue } from "./event-queue.mjs";
import {
  inputItems,
  normalizeAppServerItem,
  normalizeUsage,
  sandboxPolicy,
} from "./events.mjs";
export class AppServerThread {
  constructor(client, options, id) {
    this.client = client;
    this.options = options;
    this.id = id ?? null;
    this.resuming = Boolean(id);
    this.activeTurnId = null;
  }

  async prepare() {
    if (!this.preparing)
      this.preparing = (async () => {
        const options = this.options;
        const response = await this.client.request(
          this.resuming ? "thread/resume" : "thread/start",
          {
            ...(this.resuming ? { threadId: this.id, excludeTurns: true } : {}),
            ...(!this.resuming && options.ephemeral ? { ephemeral: true } : {}),
            ...(!this.resuming && options.dynamicTools?.length
              ? { dynamicTools: options.dynamicTools }
              : {}),
            ...(options.developerInstructions
              ? { developerInstructions: options.developerInstructions }
              : {}),
            cwd: options.workingDirectory,
            model: options.model,
            sandbox: options.sandboxMode ?? "workspace-write",
            approvalPolicy: options.approvalPolicy ?? "never",
            config: {
              web_search: options.webSearchMode ?? "disabled",
              ...((options.reasoningEffort ?? options.modelReasoningEffort)
                ? {
                    model_reasoning_effort:
                      options.reasoningEffort ?? options.modelReasoningEffort,
                  }
                : {}),
              ...(options.disableShellTool
                ? {
                    "features.shell_tool": false,
                    "features.unified_exec": false,
                  }
                : {}),
            },
          },
        );
        this.id = response.thread.id;
        this.model = response.model ?? response.thread.model ?? options.model;
        if (
          options.requireWritableSandbox &&
          response.sandbox?.type === "readOnly"
        ) {
          const error = new Error(
            "The native sandbox is not ready for workspace writes",
          );
          error.code = "AGENT_SANDBOX_NOT_READY";
          throw error;
        }
      })();
    return this.preparing;
  }

  async steer(text) {
    if (!this.activeTurnId || this.ending) return false;
    const turnId = this.activeTurnId;
    try {
      const result = await this.client.request("turn/steer", {
        threadId: this.id,
        expectedTurnId: turnId,
        input: inputItems(text),
      });
      return result.turnId === turnId;
    } catch (error) {
      // An explicit server rejection is safe to queue as a new turn. A timeout
      // or broken transport is ambiguous and must not duplicate the instruction.
      if (typeof error.code === "number") return false;
      throw error;
    }
  }

  async dispose() {
    if (!this.id) return;
    await this.client.request("thread/unsubscribe", { threadId: this.id });
    this.client.threadUsage.delete(this.id);
  }

  async interrupt() {
    if (this.activeTurnId && !this.ending)
      await this.client.request("turn/interrupt", {
        threadId: this.id,
        turnId: this.activeTurnId,
      });
  }

  async runStreamed(input, turnOptions = {}) {
    return { events: this.stream(input, turnOptions) };
  }

  async *stream(
    input,
    {
      signal,
      outputSchema,
      collaborationMode,
      model = this.options.model,
      reasoningEffort = this.options.reasoningEffort ??
        this.options.modelReasoningEffort,
    } = {},
  ) {
    signal?.throwIfAborted();
    await this.prepare();
    if (
      collaborationMode &&
      (!this.model || !["plan", "default"].includes(collaborationMode))
    )
      throw new Error("COLLABORATION_MODE_UNAVAILABLE");
    if (this.activeTurnId || this.starting)
      throw new Error("A turn is already active");
    this.starting = true;
    this.ending = false;
    const queue = new EventQueue();
    let usage = null;
    let usageBaseline = this.client.threadUsage.get(this.id);
    let abortTimer;
    const onFailure = (error) => queue.end(error);
    const onNotification = ({ method, params }) => {
      if (params?.threadId !== this.id) return;
      const incomingTurn = params.turnId ?? params.turn?.id;
      if (
        this.activeTurnId &&
        incomingTurn &&
        incomingTurn !== this.activeTurnId
      )
        return;
      if (method === "turn/started") {
        this.activeTurnId = params.turn.id;
        queue.push({ type: "turn.started" });
      } else if (method === "thread/tokenUsage/updated") {
        const last = normalizeUsage(params.tokenUsage?.last);
        const total = normalizeUsage(params.tokenUsage?.total);
        if (total && last) {
          usageBaseline ??= Object.fromEntries(
            Object.entries(total).map(([key, value]) => [
              key,
              Math.max(0, value - last[key]),
            ]),
          );
          const monotonic = Object.entries(total).every(
            ([key, value]) => value >= usageBaseline[key],
          );
          usage = monotonic
            ? {
                ...Object.fromEntries(
                  Object.entries(total).map(([key, value]) => [
                    key,
                    value - usageBaseline[key],
                  ]),
                ),
                scope: "turn",
              }
            : { ...last, scope: "last_response_only" };
          this.client.threadUsage.set(this.id, total);
        } else usage = last ? { ...last, scope: "last_response_only" } : null;
      } else if (
        ["item/started", "item/updated", "item/completed"].includes(method)
      ) {
        const item = normalizeAppServerItem(params.item);
        if (item) queue.push({ type: method.replace("/", "."), item });
      } else if (method === "turn/completed") {
        this.ending = true;
        if (params.turn.status === "completed")
          queue.push({ type: "turn.completed", usage });
        else
          queue.push({
            type: "turn.failed",
            error: {
              message:
                params.turn.error?.message ??
                `Codex turn ${params.turn.status}`,
            },
          });
        queue.end();
      } else if (method === "error" && !params.willRetry) {
        queue.end(new Error(params.error?.message ?? "Codex turn failed"));
      }
    };
    const abort = () => {
      void this.interrupt().catch((error) => queue.end(error));
      abortTimer ??= setTimeout(() => {
        // The actual worker must stop before the queue reports cancellation.
        this.client.fail(new Error("Codex did not acknowledge cancellation"));
        queue.end(signal.reason ?? new Error("Codex turn aborted"));
      }, 5_000);
    };
    this.client.on("notification", onNotification);
    this.client.on("failure", onFailure);
    if (this.options.onToolCall)
      this.client.dynamicHandlers.set(this.id, (params) => {
        signal?.throwIfAborted();
        if (
          this.ending ||
          !this.activeTurnId ||
          params.turnId !== this.activeTurnId ||
          params.namespace ||
          !(
            this.options.allowedDynamicToolNames ??
            this.options.dynamicTools?.map((tool) => tool.name)
          )?.includes(params.tool)
        )
          throw new Error("Tool call does not belong to this active turn");
        return this.options.onToolCall(params);
      });
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      const result = await this.client.request("turn/start", {
        threadId: this.id,
        input: inputItems(input),
        cwd: this.options.workingDirectory,
        model,
        effort: reasoningEffort ?? null,
        approvalPolicy: this.options.approvalPolicy ?? "never",
        sandboxPolicy: sandboxPolicy(this.options),
        ...(collaborationMode
          ? {
              collaborationMode: {
                mode: collaborationMode,
                settings: {
                  model: model ?? this.model,
                  reasoning_effort: reasoningEffort ?? null,
                  developer_instructions:
                    collaborationMode === "plan"
                      ? "相談・計画モードです。既存の権限制約を守って情報を読み取り、方針と質問を会話で示してください。ファイル編集・実装・外部への書き込みは行わないでください。実行開始はアプリの実行するボタンでのみ切り替わります。ユーザーへの質問は通常の文章で提示し、request_user_inputは使用しないでください。計画を提示したら、このターンを終了して返答を待ってください。"
                      : null,
                },
              },
            }
          : {}),
        ...(outputSchema ? { outputSchema } : {}),
      });
      this.activeTurnId ??= result.turn.id;
      this.starting = false;
      if (signal?.aborted) abort();
      yield { type: "thread.started", thread_id: this.id };
      for await (const event of queue) yield event;
      signal?.throwIfAborted();
    } catch (error) {
      // A start timeout may have launched a worker without returning its ID.
      // Tear down the transport instead of leaving an untracked writer alive.
      if (this.starting && error.code === "CODEX_RPC_TIMEOUT")
        this.client.fail(error);
      throw error;
    } finally {
      clearTimeout(abortTimer);
      if (!this.ending && this.activeTurnId)
        await this.interrupt().catch(() => {});
      this.client.off("notification", onNotification);
      this.client.off("failure", onFailure);
      this.client.dynamicHandlers.delete(this.id);
      signal?.removeEventListener("abort", abort);
      this.starting = false;
      this.activeTurnId = null;
    }
  }

  async run(input, options) {
    const items = [];
    let finalResponse = "";
    let usage = null;
    for await (const event of this.stream(input, options)) {
      if (event.type === "item.completed") {
        items.push(event.item);
        if (event.item.type === "agent_message")
          finalResponse = event.item.text;
      }
      if (event.type === "turn.completed") usage = event.usage;
      if (event.type === "turn.failed") throw new Error(event.error.message);
    }
    return { items, finalResponse, usage };
  }
}
