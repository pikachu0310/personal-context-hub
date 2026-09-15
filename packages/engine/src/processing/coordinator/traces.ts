import { randomUUID } from "node:crypto";
import type {
  CoordinatorObservation,
  CoordinatorResponse,
} from "@ido/common/contracts/coordinator";
import { describeError } from "../../domain/diagnostics.js";
import type { Repository } from "../../ports/repository.js";

export type TaskProposal = CoordinatorResponse["tasks"][number];
export type ModelValue = {
  response: CoordinatorResponse;
  modeRevision: number;
  audioRevision?: number;
  controlVersions: Record<string, number>;
  priorityVersions?: Record<string, { version: number; revision: number }>;
};
export interface TaskDecision {
  index: number;
  task: TaskProposal;
  reason: string;
  taskId?: string;
}
export interface TaskApplication {
  id: string;
  kind: "application";
  batchId: string;
  meetingId: string;
  projectId?: string;
  at: number;
  sourceIds: string[];
  initialResponse: CoordinatorResponse;
  rejections: TaskDecision[];
  repair?: {
    status: "sending" | "completed" | "failed";
    value?: ModelValue;
    error?: ReturnType<typeof describeError>;
  };
  decisions: TaskDecision[];
  priorityDecisions?: Array<{ taskId: string; reason: string }>;
  notification?: string;
  completedAt?: number;
}

export function sourceRejection(task: TaskProposal, allowed: Set<string>) {
  if (!task.sourceIds.length) return "missing_source_ids";
  if (new Set(task.sourceIds).size !== task.sourceIds.length)
    return "duplicate_source_ids";
  if (task.sourceIds.some((id) => !allowed.has(id)))
    return "source_outside_current_batch";
  return undefined;
}

// Private engine records, separate from the rolling error log and model history.
// Retained until project deletion; no credentials, transport handles or raw errors.
export class CoordinatorTraces {
  constructor(readonly store: Repository) {}

  async model<T extends CoordinatorResponse | boolean>(
    batchId: string,
    kind: "run" | "steer",
    observation: CoordinatorObservation,
    invoke: () => Promise<T>,
  ): Promise<T> {
    const entry = {
      id: randomUUID(),
      kind,
      batchId,
      meetingId: observation.meetingId,
      projectId: observation.projectId,
      at: Date.now(),
      observation: structuredClone(observation),
      status: "sending",
    };
    this.store.put("coordinator-trace", entry.id, entry);
    try {
      const response = await invoke();
      this.store.put("coordinator-trace", entry.id, {
        ...entry,
        status: "completed",
        completedAt: Date.now(),
        response,
      });
      return response;
    } catch (error) {
      this.store.put("coordinator-trace", entry.id, {
        ...entry,
        status: "failed",
        completedAt: Date.now(),
        error: describeError(error),
      });
      throw error;
    }
  }
}
