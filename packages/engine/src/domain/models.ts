import type { Grant } from "@ido/common/contracts/protocol";
export interface Device {
  lifecycleVersion?: number;
  profile?: import("@ido/common/contracts/protocol").ClientProfile;
  codexConnected?: boolean;
  id: string;
  name: string;
  userId: string;
  publicKey: string;
  revoked: boolean;
  generation: number;
  grants: Grant[];
  slots: number;
  lastAssigned: number;
  executionPolicyVersion?: number;
}
export interface Meeting {
  knowledge?: import("@ido/common/contracts/knowledge").MeetingKnowledge;
  startedAt?: number;
  closedAt?: number;
  id: string;
  name: string;
  projectId?: string;
  summary: string;
  messages: Array<{
    id: string;
    authorId: string;
    text: string;
    at: number;
    stage: string;
    errorId?: string;
  }>;
}

export type ProcessingStep = "transcription" | "reply" | "minutes" | "delivery";
export type StepState =
  "pending" | "running" | "completed" | "failed" | "skipped" | "interrupted";
export interface Message {
  id: string;
  meetingId: string;
  authorId: string;
  authorName?: string;
  role?: "user" | "assistant";
  origin?: "audio" | "text";
  inputId?: string;
  complete?: boolean;
  command?: string;
  capture?: {
    sessionId: string;
    utteranceId: string;
    segmentIndex: number;
    startedAt: number;
    endedAt?: number;
    final?: boolean;
  };
  text: string;
  replyText?: string;
  at: number;
  stage: string;
  errorId?: string;
  steps?: Partial<
    Record<ProcessingStep, { state: StepState; errorId?: string }>
  >;
}
