import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  query,
  createSdkMcpServer,
  tool,
  type Query,
  type Options,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentRuntimeOptions, AgentThreadOptions } from "./types.js";
import { claudeToolAllowed, claudeTools } from "./claude-policy.js";

export class ClaudeRuntime {
  threads = new Set<ClaudeThread>();
  constructor(
    readonly config: AgentRuntimeOptions,
    readonly queryFactory: typeof query = query,
  ) {}
  startThread(options: AgentThreadOptions) {
    return this.resumeThread(undefined, options);
  }
  resumeThread(id: string | undefined, options: AgentThreadOptions) {
    const thread = new ClaudeThread(this, options, id);
    this.threads.add(thread);
    return thread;
  }
  async close() {
    for (const thread of this.threads) thread.close();
    this.threads.clear();
  }
}

class ClaudeThread {
  activeTurnId: string | null = null;
  current?: Query;
  pending: string[] = [];
  closed = false;
  constructor(
    readonly runtime: ClaudeRuntime,
    readonly options: AgentThreadOptions,
    public id?: string,
  ) {}
  async steer(text: string) {
    if (this.closed || !this.activeTurnId) return false;
    this.pending.push(text);
    return true;
  }
  close() {
    this.closed = true;
    this.current?.close();
  }
  async runStreamed(
    prompt: string,
    turn: {
      signal: AbortSignal;
      collaborationMode?: string;
      model?: string;
      reasoningEffort?: string | null;
    },
  ) {
    return { events: this.events(prompt, turn) };
  }
  async *events(
    prompt: string,
    turn: {
      signal: AbortSignal;
      collaborationMode?: string;
      model?: string;
      reasoningEffort?: string | null;
    },
  ): AsyncGenerator<any> {
    if (this.closed) throw new Error("CLAUDE_CLOSED");
    const planning = turn.collaborationMode === "plan";
    const abort = () => this.close();
    turn.signal.addEventListener("abort", abort, { once: true });
    this.activeTurnId = randomUUID();
    try {
      while (true) {
        turn.signal.throwIfAborted();
        const sharedTools = this.options.dynamicTools ?? [];
        const sharedName = (name: string) =>
          sharedTools.some((def) => name === `mcp__ido__${def.name}`);
        const sharedServer =
          sharedTools.length && this.options.onToolCall
            ? createSdkMcpServer({
                name: "ido",
                tools: sharedTools.map((def) => {
                  const schema = z.fromJSONSchema(
                    def.inputSchema as Parameters<typeof z.fromJSONSchema>[0],
                  ) as z.ZodObject;
                  return tool(
                    def.name,
                    def.description,
                    schema.shape,
                    async (args) => {
                      turn.signal.throwIfAborted();
                      const result = await this.options.onToolCall!({
                        tool: def.name,
                        arguments: args,
                        callId: randomUUID(),
                        threadId: this.id,
                        turnId: this.activeTurnId ?? undefined,
                      });
                      return {
                        content: [
                          {
                            type: "text" as const,
                            text: JSON.stringify(result),
                          },
                        ],
                      };
                    },
                  );
                }),
              })
            : undefined;
        const options: Options = {
          model: turn.model ?? this.options.model,
          effort: (turn.reasoningEffort ??
            this.options.reasoningEffort) as Options["effort"],
          cwd: this.options.workingDirectory,
          env: this.runtime.config.env,
          resume: this.id,
          settingSources: [],
          mcpServers: sharedServer ? { ido: sharedServer } : {},
          strictMcpConfig: true,
          plugins: [],
          tools: claudeTools.filter(
            (tool) =>
              !(
                ["Write", "Edit", "Bash"].includes(tool) &&
                (planning || this.options.sandboxMode === "read-only")
              ) && !(tool === "Bash" && !this.options.networkAccessEnabled),
          ),
          permissionMode: "default",
          settings: {
            permissions: { ask: claudeTools },
            disableClaudeAiConnectors: true,
          },
          maxTurns: 50,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: planning
              ? "Discuss and propose a plan only. Do not edit files or execute shell commands. The user will explicitly start implementation from the app."
              : "Perform the task in the assigned working directory. Follow the tool approvals from the app.",
          },
          // Hooks run before automatic tool permissions; unknown tools fail closed.
          hooks: {
            PreToolUse: [
              {
                hooks: [
                  async (event) => {
                    if (event.hook_event_name !== "PreToolUse") return {};
                    if (sharedName(event.tool_name) && !turn.signal.aborted)
                      return {};
                    const input = event.tool_input as Record<string, unknown>;
                    const allowed =
                      input &&
                      (await claudeToolAllowed(
                        event.tool_name,
                        input,
                        this.options,
                        planning,
                      ));
                    if (allowed && !turn.signal.aborted) return {};
                    return {
                      hookSpecificOutput: {
                        hookEventName: "PreToolUse",
                        permissionDecision: "deny",
                        permissionDecisionReason:
                          "IDO Agent local task tool policy and explicit approval",
                      },
                    };
                  },
                ],
              },
            ],
          },
          canUseTool: async (tool, input) => {
            if (sharedName(tool) && !turn.signal.aborted)
              return { behavior: "allow", updatedInput: input };
            if (
              !turn.signal.aborted &&
              (await claudeToolAllowed(tool, input, this.options, planning))
            ) {
              const decision =
                this.options.approvalPolicy === "never"
                  ? { decision: "accept" }
                  : await this.runtime.config.onApprovalRequest(
                      `claude/${tool}`,
                      input,
                    );
              if (
                decision.decision === "accept" &&
                !turn.signal.aborted &&
                (await claudeToolAllowed(tool, input, this.options, planning))
              )
                return { behavior: "allow", updatedInput: input };
            }
            return {
              behavior: "deny",
              message: "IDO Agent did not grant this operation.",
            };
          },
          spawnClaudeCodeProcess: (options) =>
            spawn(options.command, options.args, {
              cwd: options.cwd,
              env: options.env,
              signal: options.signal,
              windowsHide: true,
              stdio: ["pipe", "pipe", "pipe"],
            }),
        };
        this.current = this.runtime.queryFactory({ prompt, options });
        let result: string | undefined;
        const tools = new Map<
          string,
          { name: string; input: Record<string, unknown> }
        >();
        for await (const message of this.current) {
          turn.signal.throwIfAborted();
          if (
            "session_id" in message &&
            message.session_id &&
            this.id !== message.session_id
          ) {
            this.id = message.session_id;
            yield { type: "thread.started", thread_id: this.id };
          }
          if (message.type === "system" && message.subtype === "init") {
            // Each resumed discussion must acknowledge the pending instructions.
            yield { type: "thread.started", thread_id: message.session_id };
            yield { type: "turn.started" };
          }
          if (message.type === "assistant") {
            if (message.error) throw new Error("CLAUDE_AUTH_OR_API_FAILED");
            for (const block of message.message.content) {
              if (block.type === "text")
                yield {
                  type: "item.completed",
                  item: {
                    type: "agent_message",
                    id: randomUUID(),
                    text: block.text,
                    phase: "commentary",
                  },
                };
              if (block.type === "tool_use") {
                const input = block.input as Record<string, unknown>;
                tools.set(block.id, { name: block.name, input });
                yield {
                  type: "item.started",
                  item:
                    block.name === "Bash"
                      ? {
                          type: "command_execution",
                          id: block.id,
                          command: String(input.command ?? ""),
                          status: "in_progress",
                        }
                      : {
                          type: "mcp_tool_call",
                          id: block.id,
                          server: "Claude",
                          tool: block.name,
                          status: "in_progress",
                        },
                };
              }
            }
          }
          if (
            message.type === "user" &&
            Array.isArray(message.message.content)
          ) {
            for (const block of message.message.content) {
              if (block.type !== "tool_result") continue;
              const tool = tools.get(block.tool_use_id);
              if (!tool) continue;
              const status = block.is_error ? "failed" : "completed";
              if (tool.name === "Bash")
                yield {
                  type: "item.completed",
                  item: {
                    type: "command_execution",
                    id: block.tool_use_id,
                    command: String(tool.input.command ?? ""),
                    aggregated_output:
                      typeof block.content === "string" ? block.content : "",
                    status,
                  },
                };
              else if (["Write", "Edit"].includes(tool.name) && !block.is_error)
                yield {
                  type: "item.completed",
                  item: {
                    type: "file_change",
                    id: block.tool_use_id,
                    status,
                    changes: [
                      {
                        path: String(tool.input.file_path ?? ""),
                        kind: "update",
                      },
                    ],
                  },
                };
              else
                yield {
                  type: "item.completed",
                  item: {
                    type: "mcp_tool_call",
                    id: block.tool_use_id,
                    server: "Claude",
                    tool: tool.name,
                    status,
                  },
                };
              tools.delete(block.tool_use_id);
            }
          }
          if (message.type === "result") {
            if (message.subtype !== "success" || message.is_error)
              throw new Error("CLAUDE_TURN_FAILED");
            result = message.result;
          }
        }
        this.current = undefined;
        if (!result?.trim()) throw new Error("CLAUDE_TASK_INCOMPLETE");
        if (!this.pending.length) {
          yield {
            type: "item.completed",
            item: {
              type: "agent_message",
              id: randomUUID(),
              text: result,
              phase: planning ? "plan" : "final_answer",
            },
          };
          break;
        }
        prompt = this.pending.splice(0).join("\n\n");
      }
      yield { type: "turn.completed" };
    } finally {
      this.activeTurnId = null;
      this.current?.close();
      this.current = undefined;
      turn.signal.removeEventListener("abort", abort);
    }
  }
}
