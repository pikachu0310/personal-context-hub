import { Client, GatewayIntentBits, Events, ChannelType } from "discord.js";
import {
  joinVoiceChannel,
  EndBehaviorType,
  entersState,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  StreamType,
} from "@discordjs/voice";
import { Readable } from "node:stream";
import prism from "prism-media";
import { text, discordManifest } from "../../common/src/protocol.js";
import { exchange } from "./auth.js";
let client: Client | undefined;
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
      if (message.audio)
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
    client.once(Events.ClientReady, async () => {
      emit({ type: "status", status: "connected" });
      if (!config.voiceChannelId) return;
      const guild = await client!.guilds.fetch(config.guildId);
      const channel = await guild.channels.fetch(config.voiceChannelId);
      if (channel?.type !== ChannelType.GuildVoice)
        throw new Error("VOICE_CHANNEL_REQUIRED");
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });
      connection.subscribe(player);
      await entersState(connection, VoiceConnectionStatus.Ready, 20000);
      const active = new Set<string>();
      connection.receiver.speaking.on("start", (userId) => {
        if (active.has(userId) || active.size >= 8) return;
        active.add(userId);
        const stream = connection.receiver.subscribe(userId, {
          end: { behavior: EndBehaviorType.AfterSilence, duration: 1000 },
        });
        const decoder = new prism.opus.Decoder({
          rate: 48000,
          channels: 2,
          frameSize: 960,
        });
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
        });
        decoder.once("end", () => {
          if (size)
            emit({
              type: "input",
              guildId: guild.id,
              channelId: channel.id,
              userId,
              eventId: `voice-${Date.now()}-${userId}`,
              audio: wav(Buffer.concat(chunks)).toString("base64"),
            });
        });
      });
    });
    await client.login(text(config.botToken, 4000));
  })().catch(() => emit({ type: "status", status: "failed" }));
});
process.on("disconnect", () => {
  client?.destroy();
  process.exit(0);
});
