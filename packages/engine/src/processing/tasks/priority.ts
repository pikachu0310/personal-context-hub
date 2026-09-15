import type { Task } from "@ido/common/contracts/protocol";
import type { TaskEvaluation, TaskPriority } from "@ido/common/contracts/work";

// Policy values are tuning defaults, not calibrated probabilities.
export const priorityPolicy = {
  version: 1,
  weights: { immediacy: 25, certainty: 35, importance: 25, specificity: 15 },
  researchThreshold: 40,
  workThreshold: 60,
  requestedFloor: 80,
  minimumSpecificity: 2,
  notificationThreshold: 70,
  maximumPendingProactive: 8,
} as const;

export function parseTaskEvaluation(value: unknown): TaskEvaluation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const e = value as TaskEvaluation;
  const axes = [...Object.keys(priorityPolicy.weights), "resolution"] as const;
  if (
    !Array.isArray(e.sourceIds) ||
    !e.evidence ||
    axes.some((axis) => {
      const detail = e.evidence[axis as keyof TaskEvaluation["evidence"]];
      return (
        !detail ||
        typeof detail.reason !== "string" ||
        !detail.reason.trim() ||
        detail.reason.length > 300 ||
        !Array.isArray(detail.sourceIds) ||
        detail.sourceIds.length > 20 ||
        (e.sourceIds.length > 0 && !detail.sourceIds.length) ||
        detail.sourceIds.some((id) => !e.sourceIds?.includes(id))
      );
    }) ||
    Object.keys(priorityPolicy.weights).some((key) => {
      const score = e[key as keyof typeof priorityPolicy.weights];
      return !Number.isInteger(score) || score < 0 || score > 4;
    }) ||
    !["unresolved", "resolved", "unknown"].includes(e.resolution) ||
    !["requested", "proposal", "opportunity"].includes(e.intent) ||
    typeof e.reason !== "string" ||
    !e.reason.trim() ||
    e.reason.length > 600 ||
    !Array.isArray(e.sourceIds) ||
    e.sourceIds.length > 20 ||
    e.sourceIds.some(
      (id) => typeof id !== "string" || !id || id.length > 200,
    ) ||
    new Set(e.sourceIds).size !== e.sourceIds.length
  )
    return null;
  return {
    evidence: structuredClone(e.evidence),
    immediacy: e.immediacy,
    certainty: e.certainty,
    importance: e.importance,
    specificity: e.specificity,
    resolution: e.resolution,
    intent: e.intent,
    reason: e.reason,
    sourceIds: [...e.sourceIds],
  };
}

export function evaluatePriority(e: TaskEvaluation, kind?: string) {
  const requested = e.intent === "requested" && e.certainty === 4;
  const concrete = e.specificity >= priorityPolicy.minimumSpecificity;
  const weighted = Object.entries(priorityPolicy.weights).reduce(
    (sum, [key, weight]) =>
      sum + (e[key as keyof typeof priorityPolicy.weights] * weight) / 4,
    0,
  );
  const score =
    requested && concrete
      ? Math.max(priorityPolicy.requestedFloor, weighted)
      : weighted;
  const threshold =
    kind === "research"
      ? priorityPolicy.researchThreshold
      : priorityPolicy.workThreshold;
  const reason =
    e.resolution === "resolved"
      ? "resolved"
      : !concrete
        ? "unspecified"
        : score < threshold
          ? "below_threshold"
          : "eligible";
  return {
    score,
    eligible: reason === "eligible",
    reason,
    notify:
      reason === "eligible" &&
      requested &&
      score >= priorityPolicy.notificationThreshold,
  };
}

export function taskPriority(
  evaluation: TaskEvaluation,
  kind: string | undefined,
  identity: Pick<TaskPriority, "batchId" | "version" | "runRevision">,
): TaskPriority {
  return {
    evaluation,
    ...evaluatePriority(evaluation, kind),
    ...identity,
    policyVersion: priorityPolicy.version,
  };
}

export function schedulingPriority(
  task: Pick<Task, "priority" | "trigger" | "kind">,
) {
  return task.priority
    ? evaluatePriority(task.priority.evaluation, task.kind).score
    : task.trigger !== "proactive"
      ? 80
      : task.kind === "research"
        ? 40
        : 60;
}
export function canSchedule(task: Pick<Task, "priority" | "kind">) {
  return (
    !task.priority ||
    (task.priority.reason !== "deferred" &&
      evaluatePriority(task.priority.evaluation, task.kind).eligible)
  );
}
