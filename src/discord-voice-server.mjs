import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from "@discordjs/voice";
import { ChannelType, Client, GatewayIntentBits } from "discord.js";
import prism from "prism-media";
import { readDiscordTokenStore } from "./discord-config.mjs";
import {
  pcmDurationSeconds,
  ttsPcm24kMonoToDiscordRaw,
  wrapPcmAsWav,
} from "./discord-voice-audio.mjs";
import {
  describeDiscordVoiceConfig,
  loadDiscordVoiceConfig,
} from "./discord-voice-config.mjs";
import {
  CodexVoiceRunner,
  createOpenAIAudioAdapter,
} from "./discord-voice-openai.mjs";
import { DiscordVoiceSession } from "./discord-voice-session.mjs";

const PCM_BYTES_PER_SECOND = 48_000 * 2 * 2;

function createDiscordPlayer(connection) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  connection.subscribe(player);
  return async (ttsPcm) => {
    const raw = ttsPcm24kMonoToDiscordRaw(ttsPcm);
    const seconds = raw.length / PCM_BYTES_PER_SECOND;
    const resource = createAudioResource(Readable.from(raw), {
      inputType: StreamType.Raw,
    });
    player.play(resource);
    await entersState(player, AudioPlayerStatus.Playing, 5_000);
    await entersState(
      player,
      AudioPlayerStatus.Idle,
      Math.max(10_000, Math.ceil(seconds * 1_000) + 10_000),
    );
  };
}

function subscribeToAllowedSpeaker({
  connection,
  config,
  session,
  postText,
  logger,
}) {
  const active = new Set();
  connection.receiver.speaking.on("start", (userId) => {
    if (userId !== config.allowedUserId || active.has(userId)) return;
    active.add(userId);
    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: config.silenceMs,
      },
    });
    const decoder = new prism.opus.Decoder({
      rate: 48_000,
      channels: 2,
      frameSize: 960,
    });
    const chunks = [];
    let byteLength = 0;
    let rejected = false;
    const maximumBytes = config.maximumAudioSeconds * PCM_BYTES_PER_SECOND;

    decoder.on("data", (chunk) => {
      if (rejected) return;
      byteLength += chunk.length;
      if (byteLength > maximumBytes) {
        rejected = true;
        active.delete(userId);
        opusStream.destroy();
        decoder.destroy();
        void postText(
          `⚠️ 発話が${config.maximumAudioSeconds}秒を超えたため破棄しました。`,
        );
        return;
      }
      chunks.push(chunk);
    });
    const release = () => active.delete(userId);
    decoder.once("close", release);
    decoder.once("error", (error) => {
      release();
      logger.error?.({
        component: "discord-voice",
        event: "decode_failed",
        error: error.message,
      });
    });
    decoder.once("end", () => {
      release();
      if (rejected) return;
      const pcm = Buffer.concat(chunks, byteLength);
      if (pcmDurationSeconds(pcm) * 1_000 < config.minimumAudioMs) return;
      if (!session.enqueue(wrapPcmAsWav(pcm), { userId })) {
        void postText(
          "⚠️ 音声ターンが混雑しています。少し待ってからもう一度話してください。",
        );
      }
    });
    opusStream.pipe(decoder);
  });
}

export async function startDiscordVoiceCodex({
  config = loadDiscordVoiceConfig(),
  client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  }),
  logger = console,
} = {}) {
  const credential = await readDiscordTokenStore();
  await client.login(credential.token);
  const guild = await client.guilds.fetch(config.guildId);
  const [voiceChannel, textChannel] = await Promise.all([
    guild.channels.fetch(config.voiceChannelId),
    guild.channels.fetch(config.textChannelId),
  ]);
  if (!voiceChannel || voiceChannel.type !== ChannelType.GuildVoice) {
    throw new Error("Configured voice channel is not a Guild Voice channel.");
  }
  if (!textChannel?.isTextBased() || typeof textChannel.send !== "function") {
    throw new Error("Configured text channel cannot receive Bot messages.");
  }
  const postText = (content) =>
    textChannel.send({ content, allowedMentions: { parse: [] } });
  const connection = joinVoiceChannel({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

  const audio = createOpenAIAudioAdapter(config);
  const codex = new CodexVoiceRunner(config);
  const session = new DiscordVoiceSession({
    transcribe: audio.transcribe,
    runCodex: (transcript) => codex.run(transcript),
    synthesize: audio.synthesize,
    postText,
    playAudio: createDiscordPlayer(connection),
    logger,
    maximumQueuedTurns: config.maximumQueuedTurns,
  });
  subscribeToAllowedSpeaker({ connection, config, session, postText, logger });
  await postText(
    "🔊 Discord音声Codexを起動しました。本人allowlistの発話だけを処理します。返答音声はAI生成です。",
  );
  logger.info?.({
    component: "discord-voice",
    event: "ready",
    ...describeDiscordVoiceConfig(config),
  });
  return {
    client,
    connection,
    session,
    async stop() {
      connection.destroy();
      client.destroy();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const service = await startDiscordVoiceCodex();
  const shutdown = async () => {
    await service.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
