export type AgentKind = "codex" | "claude";
export interface AgentRuntimeOptions {
  env: NodeJS.ProcessEnv;
  onApprovalRequest: (
    method: string,
    params: unknown,
  ) => Promise<{ decision: string }>;
}
export interface AgentThreadOptions {
  dynamicTools?: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  onToolCall?: (params: {
    threadId?: string;
    tool: string;
    arguments: unknown;
    callId: string;
    turnId?: string;
  }) => Promise<unknown>;
  approvalPolicy?: string;
  model?: string;
  reasoningEffort?: string;
  workingDirectory: string;
  sandboxMode: string;
  networkAccessEnabled: boolean;
}
