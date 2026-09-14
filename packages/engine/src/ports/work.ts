import type { Task } from "@ido/common/contracts/protocol";
import type {
  ExecutionPolicy,
  TaskPriority,
  WorkReceipt,
  WorkSource,
} from "@ido/common/contracts/work";

export interface WorkRequest {
  priority?: TaskPriority;
  // Set by the Engine input route, never inferred from the actor's ID.
  sourcePluginId?: string;
  trigger?: "requested" | "proactive";
  requestKey: string;
  meetingId: string;
  projectId: string;
  authorId: string;
  title?: string;
  request: string;
  kind?: string;
  sourceIds?: string[];
  sourceStatements?: WorkSource[];
  sourceSequences?: number[];
  executionPolicy?: ExecutionPolicy;
  network?: boolean;
}
export interface WorkControl {
  sourcePluginId?: string;
  taskId: string;
  authorId: string;
  type: "stop" | "instruction" | "retry";
  instruction?: string;
  continuation?: string;
  requestKey: string;
  expectedControlVersion?: number;
  instructionResolution?: "retry" | "discard";
}
export interface WorkResult {
  id: string;
  meetingId: string;
  projectId: string;
  title: string;
  result: string;
  state: Task["state"];
  runId: string;
  runRevision: number;
  specRevision: number;
  resultSpecRevision?: number;
  superseded: boolean;
  sourceIds: string[];
  sourceStatements: WorkSource[];
  sourceSequences: number[];
}
export interface PriorityUpdate {
  taskId: string;
  projectId: string;
  expectedRevision: number;
  expectedControlVersion: number;
  expectedVersion: number;
  priority: TaskPriority;
}
export interface WorkPort {
  // Release after the synchronous registration/reassessment phase.
  deferDispatch?(): () => void;
  prioritize?(updates: PriorityUpdate[]): string[];
  submit(request: WorkRequest): Task;
  control(control: WorkControl): WorkReceipt;
  list(meetingId?: string): Task[];
  getReceipt(
    key: Pick<WorkRequest, "requestKey" | "authorId" | "projectId">,
  ): Task | undefined;
  getResult(taskId: string): WorkResult | undefined;
}
