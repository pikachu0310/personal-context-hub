import type { DiscordState } from "../runtime/state.js";
import { audioOutput } from "./audio.js";
export async function deliver(
  state: DiscordState,
  message: Record<string, unknown>,
) {
  const epoch = state.speechEpoch;
  const valid = () =>
    epoch === state.speechEpoch &&
    message.channelId === state.config.textChannelId;
  if (state.client) {
    if (message.channelId !== state.config.textChannelId) return;
    if (message.content) {
      const channel = await state.client.channels.fetch(
        String(message.channelId),
      );
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
