import type { Grant } from "../../../common/src/contracts/protocol.js";
export interface Device {
  id: string;
  name: string;
  userId: string;
  publicKey: string;
  revoked: boolean;
  generation: number;
  grants: Grant[];
  slots: number;
  lastAssigned: number;
}
export interface Meeting {
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
  text: string;
  replyText?: string;
  at: number;
  stage: string;
  errorId?: string;
  steps?: Partial<
    Record<ProcessingStep, { state: StepState; errorId?: string }>
  >;
}
