import type { Implementation } from "@ido/common/contracts/api";
import type {
  MinutesTaskContext,
  MinutesTaskResult,
} from "@ido/common/contracts/work";
import type { Task } from "@ido/common/contracts/protocol";
import type { Meeting } from "../domain/models.js";
export interface Models {
  readonly transcriptionModel?: string;
  doctor(): Promise<{ ok: boolean }>;
  transcribe(buffer: Buffer): Promise<string>;
  speak(text: string): Promise<string>;
  answer(
    meeting: Meeting | undefined,
    tasks: Task[],
    question: string,
  ): Promise<string>;
  summarize?(
    meeting: Meeting,
    taskLinks: string[],
    taskResults?: MinutesTaskResult[],
    tasks?: MinutesTaskContext[],
    implementations?: Implementation[],
  ): Promise<string>;
  update(
    meeting: Meeting,
    messageId: string,
  ): Promise<{ minutes: string; task: string | null }>;
}
