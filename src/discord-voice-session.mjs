// Existing imports remain supported; the runtime composes the engine directly.
import { TurnSession } from "./engine/turn-session.mjs";
import { MeetingSession } from "./engine/meeting-session.mjs";
import { TaskQueue } from "./engine/task-queue.mjs";
import { discordPresentation } from "./adapters/discord/presentation.mjs";
export * from "./engine/shared.mjs";
export * from "./engine/observation/observation.mjs";
export {
  splitDiscordText,
  escapeDiscordMarkdown,
  formatMeetingTranscript,
} from "./adapters/discord/presentation.mjs";
export class DiscordVoiceSession extends TurnSession {
  constructor(options) {
    super({
      presentation: discordPresentation,
      ...options,
      run: options.run ?? options.runCodex,
    });
  }
}
export class DiscordVoiceMeetingSession extends MeetingSession {
  constructor(options) {
    super({ presentation: discordPresentation, ...options });
  }
}
export class DiscordVoiceTaskQueue extends TaskQueue {
  constructor(options) {
    super({ presentation: discordPresentation, ...options });
  }
}
