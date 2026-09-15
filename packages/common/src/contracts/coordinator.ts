// Serializable contracts shared by the conversation engine and a model host.
// Provider objects, credentials, local directories and sockets do not cross it.
export const COORDINATOR_PROTOCOL = 1;
export type ConversationMode = "text-speech" | "live";

export interface CoordinatorHandle {
  backend: string;
  meetingId: string;
  threadId: string;
}

export interface CoordinatorSource {
  handled?: boolean;
  meetingId?: string;
  id: string;
  authorId: string;
  authorName?: string;
  text: string;
  at: number;
  origin: "audio" | "text";
  command?: "ask" | "task" | "stop" | "steer";
  projectId?: string;
  complete?: boolean;
  requestReply?: boolean;
  direct?: boolean;
  workAllowed?: boolean;
  researchAllowed?: boolean;
  contextOnly?: boolean;
}

export interface SpeechReview {
  candidateId: string;
  revision: number;
  state: "queued" | "playing" | "interrupted";
  text: string;
  sourceIds: string[];
  targets: Array<{ text: string; resultId?: string; runRevision?: number }>;
  provider: "text-speech" | "live";
  conversation: Array<{ id: string; authorId: string; text: string }>;
}
export interface SpeechDecision {
  candidateId: string;
  revision: number;
  action: "continue" | "stop" | "replace" | "discard";
  text: string | null;
}

export type CoordinatorEvent =
  | { id: string; type: "speech_review"; review: SpeechReview }
  | {
      id: string;
      type: "message";
      source: CoordinatorSource;
      priority?: "normal" | "immediate";
    }
  | {
      id: string;
      type: "task_result";
      meetingId?: string;
      taskId: string;
      revision: number;
      text: string;
      sourceIds: string[];
      superseded?: boolean;
    }
  | {
      id: string;
      type: "assistant_output";
      text: string;
      provider: string;
      at: number;
    }
  | { id: string; type: "attention"; sourceIds: string[] };

export interface CoordinatorTask {
  priority?: import("./work.js").TaskPriority;
  kind?: string;
  meetingId?: string;
  id: string;
  text: string;
  state: string;
  revision: number;
  result?: string;
}

export interface CoordinatorObservation {
  deferredTasks?: Array<{ title: string; kind: string; reason: string }>;
  // Engine validation feedback for one bounded correction of task proposals.
  taskValidation?: {
    allowedSourceIds: string[];
    rejectedTasks: Array<{
      index: number;
      task: CoordinatorResponse["tasks"][number];
      reason: string;
    }>;
  };
  minutes?: Array<{
    meetingId: string;
    name: string;
    markdown?: string;
    summaryRevision?: number;
    topics: import("./knowledge.js").MeetingTopic[];
  }>;
  participants?: Array<{
    id: string;
    name: string;
    context: string;
    codexConnected: boolean;
  }>;
  meetingId: string;
  projectId?: string;
  mode: ConversationMode;
  events: CoordinatorEvent[];
  activeTasks: CoordinatorTask[];
  // Initial/recovery context is bounded by the engine. Later turns send deltas.
  context?: string;
}

export interface CoordinatorResponse {
  // Undefined only for saved legacy responses. Invalid individual assessments
  // are null, so they cannot discard unrelated replies or minutes.
  priorityEvaluations?: Array<{
    taskId: string;
    revision: number;
    expectedVersion: number;
    evaluation: import("./work.js").TaskEvaluation | null;
  }>;
  speech?: SpeechDecision | null;
  minutes?: import("./knowledge.js").MinutesUpdate[];
  reply: null | {
    delivery?: "notify" | "record_only";
    resultTaskIds?: string[];
    text: string;
    reason: "direct_answer" | "verified_correction" | "new_finding";
    sourceIds: string[];
  };
  tasks: Array<{
    evaluation?: import("./work.js").TaskEvaluation | null;
    title: string;
    kind: "research" | "implementation" | "test" | "benchmark";
    sourceIds: string[];
    acceptanceCriteria: string[];
  }>;
  controls: Array<{
    type: "stop" | "instruction";
    taskId: string;
    sourceIds: string[];
  }>;
}

export interface CoordinatorOptions {
  meetingId: string;
  projectId?: string;
  handle?: CoordinatorHandle;
  onCheckpoint?: (handle: CoordinatorHandle) => void | Promise<void>;
}

export interface CoordinatorRuntime {
  run(
    observation: CoordinatorObservation,
    options?: { signal?: AbortSignal },
  ): Promise<CoordinatorResponse>;
  // False means definitely not accepted. Unknown delivery must throw.
  steer(observation: CoordinatorObservation): Promise<boolean>;
  // Resolve only after the active model operation has settled.
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface CoordinatorFactory {
  createCoordinator(options: CoordinatorOptions): Promise<CoordinatorRuntime>;
}

export class CoordinatorDeliveryError extends Error {
  constructor(
    readonly code: string,
    // retryable is reserved for providers whose failed request cannot have
    // performed tools or changed a remote conversation. It does not mean that
    // the provider rejected the request or that no usage was billed.
    readonly delivery: "rejected" | "unknown" | "retryable",
  ) {
    super(code);
    this.name = "CoordinatorDeliveryError";
  }
}
