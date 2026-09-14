import type { DiscordState } from "../runtime/state.js";
import { audioOutput } from "./audio.js";
export async function deliver(
  state: DiscordState,
  message: Record<string, unknown>,
) {
  const epoch = state.speechEpoch;
  const allowedChannel = () =>
    message.channelId === state.config.textChannelId ||
    !!state.forum?.taskForThread(String(message.channelId));
  const valid = () => epoch === state.speechEpoch && allowedChannel();
  if (state.client) {
    if (!allowedChannel()) return;
    if (message.content) {
      const channel = await state.client.channels.fetch(
        String(message.channelId),
      );
      if (
        message.channelId !== state.config.textChannelId &&
        (!channel?.isThread() ||
          channel.parentId !== state.config.issueForumChannelId ||
          channel.guildId !== state.config.guildId)
      )
        return;
      if (channel?.isTextBased() && "send" in channel)
        for (
          let offset = 0;
          offset < String(message.content).length;
          offset += 1900
        ) {
          if (!valid()) return;
          await channel.send({
            content: String(message.content).slice(offset, offset + 1900),
            allowedMentions: { parse: [] },
          });
        }
    }
    if (message.audio || message.kind === "audio-stop")
      await audioOutput(state).deliver(message);
    return;
  }
}
