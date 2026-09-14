export type AgentKind = "codex" | "claude";
export interface AgentRuntimeOptions {
  env: NodeJS.ProcessEnv;
  onApprovalRequest: (
    method: string,
    params: unknown,
  ) => Promise<{ decision: string }>;
}
export interface AgentThreadOptions {
  model?: string;
  workingDirectory: string;
  sandboxMode: string;
  networkAccessEnabled: boolean;
}
