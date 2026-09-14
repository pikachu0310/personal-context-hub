import { TurnSession } from "../../engine/turn-session.mjs";
import { MeetingSession } from "../../engine/meeting-session.mjs";
import { TaskQueue } from "../../engine/task-queue.mjs";
import { discordPresentation } from "./presentation.mjs";
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
