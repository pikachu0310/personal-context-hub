export function selectedModel(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,127}$/.test(value)
  )
    throw new Error("INVALID_MODEL");
  return value;
}

export const claudeModels = [
  { id: "sonnet", name: "Sonnet" },
  { id: "opus", name: "Opus" },
  { id: "haiku", name: "Haiku" },
];
