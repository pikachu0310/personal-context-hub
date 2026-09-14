import {
  createAudioResource,
  StreamType,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import type { DiscordState } from "../runtime/state.js";
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
    if (
      message.audio &&
      message.speechEpoch === state.speechEpoch &&
      state.voice?.state.status === VoiceConnectionStatus.Ready
    )
      state.player.play(
        createAudioResource(
          Readable.from(Buffer.from(String(message.audio), "base64")),
          { inputType: StreamType.OggOpus },
        ),
      );
    return;
  }
}
