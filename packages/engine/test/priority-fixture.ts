import type { TaskEvaluation } from "@ido/common/contracts/work";
export function evaluation(
  sourceIds: string[] = [],
  patch: Partial<TaskEvaluation> = {},
): TaskEvaluation {
  return {
    immediacy: 3,
    certainty: 4,
    importance: 3,
    specificity: 4,
    resolution: "unresolved",
    intent: "requested",
    reason: "現在の具体的な依頼",
    sourceIds,
    evidence: Object.fromEntries(
      ["immediacy", "certainty", "importance", "specificity", "resolution"].map(
        (axis) => [axis, { reason: `${axis}の発言根拠`, sourceIds }],
      ),
    ) as TaskEvaluation["evidence"],
    ...patch,
  };
}
