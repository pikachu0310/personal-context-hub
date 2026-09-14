import {
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  VoiceConnectionStatus,
} from "@discordjs/voice";
import {
  Client,
  Events,
  GatewayIntentBits,
  type VoiceChannel,
} from "discord.js";
import prism from "prism-media";
import { text } from "../../../common/src/contracts/protocol.js";
import {
  registerVoiceCommands,
  voiceCommandHandler,
} from "../commands/voice.js";
import { discordUserAllowed } from "../input/policy.js";
import { wav } from "../input/wav.js";
import type { DiscordState } from "../runtime/state.js";
export async function start(
  state: DiscordState,
  emit: (data: Record<string, unknown>) => void,
  nextConfig: Record<string, string>,
) {
  state.config = nextConfig;
  state.client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });
  state.client.on(Events.Error, () =>
    emit({ type: "status", status: "failed" }),
  );
  state.client.on(Events.MessageCreate, (message) => {
    if (
      message.author.bot ||
      !discordUserAllowed(state.config, message.author.id) ||
      message.guildId !== state.config.guildId ||
      message.channelId !== state.config.textChannelId
    )
      return;
    const task = message.content.startsWith("!ido task ");
    const content = task ? message.content.slice(10) : message.content;
    if (!content.trim()) return;
    emit({
      type: "input",
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      eventId: message.id,
      text: content,
      command: task ? "task" : "message",
    });
  });
  const handleCommand = voiceCommandHandler(
    state.config.guildId,
    async (channel: VoiceChannel) => {
      if (
        state.voice?.joinConfig.channelId === channel.id &&
        state.voice.state.status === VoiceConnectionStatus.Ready
      )
        return;
      if (
        state.voice &&
        state.voice.state.status !== VoiceConnectionStatus.Destroyed
      )
        state.voice.destroy();
      state.voice = undefined;
      state.speechEpoch++;
      state.player.stop();
      emit({ type: "voice", channelId: null });
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: channel.guild.id,
        adapterCreator: channel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      state.voice = connection;
      connection.on("error", () => {
        if (state.voice === connection)
          emit({ type: "voice", channelId: null });
      });
      connection.on("stateChange", (_old, connectionState) => {
        if (state.voice === connection)
          emit({
            type: "voice",
            channelId:
              connectionState.status === VoiceConnectionStatus.Ready
                ? channel.id
                : null,
          });
      });
      connection.subscribe(state.player);
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20000);
      } catch (error) {
        connection.destroy();
        if (state.voice === connection) state.voice = undefined;
        emit({ type: "voice", channelId: null });
        throw error;
      }
      emit({ type: "voice", channelId: channel.id });
      const active = new Set<string>();
      const streams = new Set<{ destroy(): void }>();
      connection.once(VoiceConnectionStatus.Destroyed, () => {
        for (const stream of streams) stream.destroy();
        streams.clear();
      });
      connection.receiver.speaking.on("start", (userId) => {
        if (
          state.voice !== connection ||
          connection.state.status !== VoiceConnectionStatus.Ready ||
          !discordUserAllowed(state.config, userId) ||
          userId === state.client?.user?.id ||
          active.has(userId) ||
          active.size >= 8
        )
          return;
        active.add(userId);
        const receivedEpoch = state.speechEpoch;
        const stream = connection.receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
        });
        const decoder = new prism.opus.Decoder({
          rate: 48000,
          channels: 2,
          frameSize: 960,
        });
        streams.add(stream);
        streams.add(decoder);
        decoder.once("close", () => streams.delete(decoder));
        const chunks: Buffer[] = [];
        let size = 0;
        const timer = setTimeout(() => stream.destroy(), 30000);
        stream.pipe(decoder);
        decoder.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > 6 * 1024 * 1024) {
            stream.destroy();
            decoder.destroy();
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", () => decoder.destroy());
        decoder.on("error", () => {});
        stream.once("close", () => {
          clearTimeout(timer);
          active.delete(userId);
          streams.delete(stream);
        });
        decoder.once("end", () => {
          if (
            size &&
            state.voice === connection &&
            connection.state.status === VoiceConnectionStatus.Ready
          )
            emit({
              type: "input",
              guildId: channel.guild.id,
              channelId: channel.id,
              userId,
              eventId: `voice-${Date.now()}-${userId}`,
              speechEpoch: receivedEpoch,
              audio: wav(Buffer.concat(chunks)).toString("base64"),
            });
        });
      });
    },
    () => {
      const previous = state.voice;
      state.voice = undefined;
      state.speechEpoch++;
      state.player.stop();
      if (previous && previous.state.status !== VoiceConnectionStatus.Destroyed)
        previous.destroy();
      emit({ type: "voice", channelId: null });
    },
    () =>
      state.voice?.state.status !== VoiceConnectionStatus.Destroyed
        ? (state.voice?.joinConfig.channelId ?? undefined)
        : undefined,
    {
      textChannelId: state.config.textChannelId,
      allowed: (userId) => discordUserAllowed(state.config, userId),
      quiet: () => {
        state.speechEpoch++;
        state.player.stop(true);
      },
      request: (event) =>
        new Promise((resolve, reject) => {
          const eventId = String(event.eventId);
          const timer = setTimeout(() => {
            state.pending.delete(eventId);
            reject(new Error("COMMAND_TIMEOUT"));
          }, 65000);
          state.pending.set(eventId, {
            resolve,
            reject: () => reject(new Error("DISCONNECTED")),
            timer,
          });
          emit({ type: "input", ...event });
        }),
    },
  );
  state.client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand())
      void handleCommand(interaction).catch(() =>
        emit({ type: "status", status: "command-error" }),
      );
  });
  state.client.once(Events.ClientReady, () => {
    void (async () => {
      const guild = await state.client!.guilds.fetch(state.config.guildId);
      await registerVoiceCommands(guild);
      emit({ type: "status", status: "connected" });
    })().catch(() =>
      emit({ type: "status", status: "command-registration-failed" }),
    );
  });
  await state.client.login(text(state.config.botToken, 4000));
}
