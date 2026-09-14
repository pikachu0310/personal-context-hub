import type { Task } from "@ido/common/contracts/protocol";
import type {
  ExecutionPolicy,
  WorkReceipt,
  WorkSource,
} from "@ido/common/contracts/work";

export interface WorkRequest {
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
  taskId: string;
  authorId: string;
  type: "stop" | "instruction" | "retry";
  instruction?: string;
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
export interface WorkPort {
  submit(request: WorkRequest): Task;
  control(control: WorkControl): WorkReceipt;
  list(meetingId?: string): Task[];
  getReceipt(
    key: Pick<WorkRequest, "requestKey" | "authorId" | "projectId">,
  ): Task | undefined;
  getResult(taskId: string): WorkResult | undefined;
}
