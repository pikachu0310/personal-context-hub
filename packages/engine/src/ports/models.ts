import type { Task } from "../../../common/src/contracts/protocol.js";
import type { Meeting } from "../domain/models.js";
export interface Models {
  doctor(): Promise<{ ok: boolean }>;
  transcribe(buffer: Buffer): Promise<string>;
  speak(text: string): Promise<string>;
  answer(
    meeting: Meeting | undefined,
    tasks: Task[],
    question: string,
  ): Promise<string>;
  update(
    meeting: Meeting,
    messageId: string,
  ): Promise<{ minutes: string; task: string | null }>;
}
