// Allowlisted SDK metadata only. Never inspect reasoning, commands, arguments,
// raw MCP results, credentials or audio to invent search details.
export function normalizeExecutionEvent(event) {
  if (!["item.started", "item.updated", "item.completed"].includes(event?.type))
    return;
  const item = event.item;
  if (
    ![
      "web_search",
      "mcp_tool_call",
      "command_execution",
      "file_change",
    ].includes(item?.type)
  )
    return;
  return {
    itemId: item.id,
    tool: item.type === "mcp_tool_call" ? item.tool : item.type,
    status:
      item.status === "failed"
        ? "failed"
        : event.type === "item.completed"
          ? "completed"
          : "running",
    query:
      item.type === "web_search" && typeof item.query === "string"
        ? item.query.slice(0, 2000)
        : undefined,
    summary: undefined,
  };
}
export function notifyExecutionEvent(sink, event) {
  if (!event) return;
  try {
    Promise.resolve(sink?.(event)).catch(() => {});
  } catch {
    /* observer isolation */
  }
}
