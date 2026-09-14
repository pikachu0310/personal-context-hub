import type { ConversationInput } from "../../../common/src/contracts/plugins.js";
import { discordUserAllowed } from "./policy.js";
export function normalizeInput(
  event: Record<string, unknown>,
  config: Record<string, string>,
  voiceChannel?: string,
): ConversationInput | undefined {
  const voice = Boolean(event.audio) || event.source === "voice-command";
  if (
    event.guildId !== config.guildId ||
    !discordUserAllowed(config, String(event.userId)) ||
    event.channelId !== (voice ? voiceChannel : config.textChannelId) ||
    (voice && !voiceChannel)
  )
    return;
  return {
    eventId: String(event.eventId),
    meetingId: config.meetingId,
    projectId: config.projectId,
    subject: String(event.userId),
    text: typeof event.text === "string" ? event.text : undefined,
    audio: typeof event.audio === "string" ? event.audio : undefined,
    command: ["ask", "task", "stop", "steer", "context"].includes(
      String(event.command),
    )
      ? (event.command as ConversationInput["command"])
      : undefined,
    taskId: typeof event.taskId === "string" ? event.taskId : undefined,
    interaction: Boolean(event.interaction),
    replyTo: {
      channelId: config.textChannelId,
      interaction: Boolean(event.interaction),
      speechEpoch: event.speechEpoch,
    },
  };
}
