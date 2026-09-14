export function inputItems(input) {
  if (typeof input === "string") return [{ type: "text", text: input }];
  return input.map((item) =>
    item.type === "local_image" ? { ...item, type: "localImage" } : item,
  );
}

export function sandboxPolicy(options) {
  const networkAccess = options.networkAccessEnabled === true;
  if (options.sandboxMode === "danger-full-access")
    return { type: "dangerFullAccess" };
  if (options.sandboxMode === "read-only")
    return { type: "readOnly", networkAccess };
  return {
    type: "workspaceWrite",
    networkAccess,
    writableRoots: [
      options.workingDirectory,
      ...(options.additionalDirectories ?? []),
    ].filter(Boolean),
  };
}

export function normalizeAppServerItem(item) {
  switch (item?.type) {
    case "agentMessage":
      return {
        id: item.id,
        type: "agent_message",
        text: item.text,
        phase: item.phase,
      };
    case "commandExecution":
      return {
        id: item.id,
        type: "command_execution",
        command: item.command,
        aggregated_output: item.aggregatedOutput ?? "",
        exit_code: item.exitCode ?? undefined,
        status: item.status === "inProgress" ? "in_progress" : item.status,
      };
    case "fileChange":
      return {
        id: item.id,
        type: "file_change",
        status: item.status,
        changes: (item.changes ?? []).map((change) => ({
          path: change.path,
          kind: change.kind?.type ?? change.kind,
        })),
      };
    case "webSearch":
      return { id: item.id, type: "web_search", query: item.query };
    case "mcpToolCall":
      return { ...item, type: "mcp_tool_call" };
    default:
      return undefined;
  }
}

export function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    input_tokens: usage.inputTokens ?? 0,
    cached_input_tokens: usage.cachedInputTokens ?? 0,
    cache_write_input_tokens: usage.cacheWriteInputTokens ?? 0,
    output_tokens: usage.outputTokens ?? 0,
    reasoning_output_tokens: usage.reasoningOutputTokens ?? 0,
  };
}
