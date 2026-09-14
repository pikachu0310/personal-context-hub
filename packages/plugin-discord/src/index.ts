import {
  Client,
  GatewayIntentBits,
  Events,
  type VoiceChannel,
} from "discord.js";
import {
  joinVoiceChannel,
  EndBehaviorType,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  StreamType,
  type VoiceConnection,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import prism from "prism-media";
import { text, discordManifest } from "../../common/src/protocol.js";
import { registerVoiceCommands, voiceCommandHandler } from "./commands.js";
import { exchange } from "./auth.js";
let client: Client | undefined;
let voice: VoiceConnection | undefined;
const player = createAudioPlayer();
const emit = (data: unknown) => process.send?.(data as object);
function wav(pcm: Buffer) {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(192000, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
process.on("message", (message: any) => {
  void (async () => {
    if (message.type === "inspect") {
      emit({ type: "manifest", manifest: discordManifest });
      return;
    }
    if (message.type === "request") {
      try {
        if (message.operation !== "oauth.exchange")
          throw new Error("UNKNOWN_OPERATION");
        emit({
          type: "reply",
          id: message.id,
          result: await exchange(message.input),
        });
      } catch {
        emit({ type: "reply", id: message.id, error: true });
      }
      return;
    }
    if (message.type === "output" && client) {
      const channel = await client.channels.fetch(String(message.channelId));
      if (channel?.isTextBased() && "send" in channel)
        await channel.send({
          content: String(message.content).slice(0, 1900),
          allowedMentions: { parse: [] },
        });
      if (message.audio && voice?.state.status === VoiceConnectionStatus.Ready)
        player.play(
          createAudioResource(
            Readable.from(Buffer.from(message.audio, "base64")),
            { inputType: StreamType.OggOpus },
          ),
        );
      return;
    }
    if (message.type !== "start" || message.v !== 1 || client) return;
    const config = message.config;
    client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
      ],
    });
    client.on(Events.Error, () => emit({ type: "status", status: "failed" }));
    client.on(Events.MessageCreate, (message) => {
      if (
        message.author.bot ||
        message.guildId !== config.guildId ||
        message.channelId !== config.textChannelId
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
      config.guildId,
      async (channel: VoiceChannel) => {
        if (
          voice?.joinConfig.channelId === channel.id &&
          voice.state.status === VoiceConnectionStatus.Ready
        )
          return;
        if (voice && voice.state.status !== VoiceConnectionStatus.Destroyed)
          voice.destroy();
        voice = undefined;
        player.stop();
        emit({ type: "voice", channelId: null });
        const connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator,
          selfDeaf: false,
          selfMute: false,
        });
        voice = connection;
        connection.on("error", () => {
          if (voice === connection) emit({ type: "voice", channelId: null });
        });
        connection.on("stateChange", (_old, state) => {
          if (voice === connection)
            emit({
              type: "voice",
              channelId:
                state.status === VoiceConnectionStatus.Ready
                  ? channel.id
                  : null,
            });
        });
        connection.subscribe(player);
        try {
          await entersState(connection, VoiceConnectionStatus.Ready, 20000);
        } catch (error) {
          connection.destroy();
          if (voice === connection) voice = undefined;
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
            voice !== connection ||
            connection.state.status !== VoiceConnectionStatus.Ready ||
            active.has(userId) ||
            active.size >= 8
          )
            return;
          active.add(userId);
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
              voice === connection &&
              connection.state.status === VoiceConnectionStatus.Ready
            )
              emit({
                type: "input",
                guildId: channel.guild.id,
                channelId: channel.id,
                userId,
                eventId: `voice-${Date.now()}-${userId}`,
                audio: wav(Buffer.concat(chunks)).toString("base64"),
              });
          });
        });
      },
      () => {
        const previous = voice;
        voice = undefined;
        player.stop();
        if (
          previous &&
          previous.state.status !== VoiceConnectionStatus.Destroyed
        )
          previous.destroy();
        emit({ type: "voice", channelId: null });
      },
      () =>
        voice?.state.status !== VoiceConnectionStatus.Destroyed
          ? (voice?.joinConfig.channelId ?? undefined)
          : undefined,
    );
    client.on(Events.InteractionCreate, (interaction) => {
      if (interaction.isChatInputCommand())
        void handleCommand(interaction).catch(() =>
          emit({ type: "status", status: "command-error" }),
        );
    });
    client.once(Events.ClientReady, () => {
      void (async () => {
        const guild = await client!.guilds.fetch(config.guildId);
        await registerVoiceCommands(guild);
        emit({ type: "status", status: "connected" });
      })().catch(() =>
        emit({ type: "status", status: "command-registration-failed" }),
      );
    });
    await client.login(text(config.botToken, 4000));
  })().catch(() => emit({ type: "status", status: "failed" }));
});
process.on("disconnect", () => {
  if (voice && voice.state.status !== VoiceConnectionStatus.Destroyed)
    voice.destroy();
  client?.destroy();
  process.exit(0);
});
