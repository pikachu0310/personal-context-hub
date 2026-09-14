import type { ConversationInput } from "@ido/common/contracts/plugins";
import { discordUserAllowed } from "./policy.js";
export function normalizeInput(
  event: Record<string, unknown>,
  config: Record<string, string>,
  voiceChannel?: string,
  audioSessionId?: string,
  forumTask?: string,
): ConversationInput | undefined {
  const voice =
    Boolean(event.audio || event.audioFrame || event.activity) ||
    event.source === "voice-command";
  const capture = event.capture as ConversationInput["capture"];
  if (
    event.guildId !== config.guildId ||
    !discordUserAllowed(config, String(event.userId)) ||
    (!forumTask &&
      event.channelId !== (voice ? voiceChannel : config.textChannelId)) ||
    (forumTask &&
      (voice ||
        event.taskId !== forumTask ||
        !["stop", "steer"].includes(String(event.command)))) ||
    (voice && !voiceChannel) ||
    (capture && audioSessionId && capture.sessionId !== audioSessionId) ||
    (event.meetingId && event.meetingId !== config.meetingId) ||
    (event.projectId && event.projectId !== config.projectId)
  )
    return;
  return {
    eventId: String(event.eventId),
    meetingId: config.meetingId,
    projectId: config.projectId,
    subject: String(event.userId),
    text: typeof event.text === "string" ? event.text : undefined,
    audio: typeof event.audio === "string" ? event.audio : undefined,
    audioFrame: event.audioFrame as ConversationInput["audioFrame"],
    activity: event.activity as ConversationInput["activity"],
    capture,
    priority: event.priority as ConversationInput["priority"],
    conversationMode:
      event.conversationMode as ConversationInput["conversationMode"],
    command: ["ask", "task", "stop", "steer", "context", "mode"].includes(
      String(event.command),
    )
      ? (event.command as ConversationInput["command"])
      : undefined,
    taskId: typeof event.taskId === "string" ? event.taskId : undefined,
    interaction: Boolean(event.interaction),
    replyTo: {
      channelId: forumTask ? event.channelId : config.textChannelId,
      interaction: Boolean(event.interaction),
      speechEpoch: event.speechEpoch,
      audioSessionId: capture?.sessionId ?? audioSessionId,
    },
  };
}
