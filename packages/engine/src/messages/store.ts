import { randomUUID } from "node:crypto";
import type {
  Meeting,
  Message,
  ProcessingStep,
  StepState,
} from "../domain/models.js";
import type { Repository } from "../ports/repository.js";
export class Messages {
  constructor(readonly repository: Repository) {}
  record(
    meetingId: string,
    authorId: string,
    text: string,
    messageId: string = randomUUID(),
  ): { meeting: Meeting; message: Message } {
    const meeting = this.repository.get<Meeting>("meeting", meetingId);
    if (!meeting) throw new Error("MEETING_NOT_FOUND");
    const existing = this.repository.get<Message>("message", messageId);
    const message: Message = {
      id: messageId,
      meetingId,
      authorId,
      authorName: this.repository.conversationAuthor(authorId)?.name,
      text,
      at: Date.now(),
      stage: "accepted",
      steps: {
        transcription: { state: "skipped" },
        reply: { state: "skipped" },
        minutes: { state: "pending" },
        delivery: { state: "skipped" },
      },
      ...existing,
    };
    message.text = text;
    this.repository.put("message", message.id, message);
    const index = meeting.messages.findIndex(
      (value) => value.id === message.id,
    );
    if (index < 0) meeting.messages.push(message);
    else meeting.messages[index] = message;
    return { meeting, message };
  }
  stage(id: string, stage: string) {
    const message = this.repository.get<Message>("message", id);
    if (message) this.repository.put("message", id, { ...message, stage });
  }
  response(id: string, replyText: string) {
    const message = this.repository.get<Message>("message", id);
    if (message) this.repository.put("message", id, { ...message, replyText });
  }
  step(id: string, step: ProcessingStep, state: StepState, errorId?: string) {
    const message = this.repository.get<Message>("message", id);
    if (!message) return;
    message.steps = { ...message.steps, [step]: { state, errorId } };
    this.repository.put("message", id, message);
  }
}
