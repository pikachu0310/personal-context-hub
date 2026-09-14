import { MinutesDocument } from "./minutes/document.js";
import { transcribe } from "../input/audio/transcribe.js";
import { Messages } from "../messages/store.js";
import { speak } from "../output/audio/speak.js";
import type { Models } from "../ports/models.js";
import type { Repository } from "../ports/repository.js";
import { answer } from "./immediate/answer.js";
import { MinutesUpdater } from "./minutes/updater.js";
import type { CoordinatedConversation } from "./coordinator/session.js";
export class Conversation {
  coordinated?: CoordinatedConversation;
  readonly minutes: MinutesUpdater;
  readonly document: MinutesDocument;
  readonly messages: Messages;
  constructor(
    readonly store: Repository,
    readonly models: Models,
  ) {
    this.document = new MinutesDocument(store, (meeting, links) => {
      if (!models.summarize) throw new Error("MINUTES_GENERATOR_UNAVAILABLE");
      return models.summarize(meeting, links);
    });
    this.minutes = new MinutesUpdater(store, models);
    this.messages = new Messages(store);
  }
  record(meetingId: string, authorId: string, text: string) {
    return this.messages.record(meetingId, authorId, text);
  }
  process(...args: Parameters<MinutesUpdater["process"]>) {
    return this.minutes.process(...args);
  }
  doctor() {
    return this.models.doctor();
  }
  transcribe(buffer: Buffer) {
    return transcribe(this.models, buffer);
  }
  speak(text: string) {
    return speak(this.models, text);
  }
  answer(meetingId: string, question: string) {
    return answer(this.store, this.models, meetingId, question);
  }
}
