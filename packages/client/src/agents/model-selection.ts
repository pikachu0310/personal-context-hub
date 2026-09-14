export function selectedModel(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (
    typeof value !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/\[\]-]{0,127}$/.test(value)
  )
    throw new Error("INVALID_MODEL");
  return value;
}

// Meeting work favors short latency and the existing Sol budget policy.
// Explicitly selected models and resumed runs bypass this selection.
export function meetingModel(
  text: string,
  kind: string | undefined,
  available: string[],
) {
  const deep =
    /(?:設計|アーキテクチャ|移行|並行|競合|整合性|セキュリティ|根本原因|複数.*(?:サービス|リポジトリ))/u.test(
      text,
    );
  const quick = !deep && kind === "research" && text.length < 800;
  const preferred = quick
    ? ["gpt-5.3-codex-spark", "gpt-5.6-sol"]
    : ["gpt-5.6-sol", "gpt-5.3-codex-spark"];
  const model = preferred.find((id) => available.includes(id));
  if (!model) throw new Error("MEETING_MODEL_UNAVAILABLE");
  return {
    model,
    modelReasoningEffort: deep
      ? ("high" as const)
      : quick
        ? ("low" as const)
        : ("medium" as const),
  };
}
