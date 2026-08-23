import { Readable } from "node:stream";
import { once } from "node:events";
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
import { ChannelType, Client, Events, GatewayIntentBits } from "discord.js";
import prism from "prism-media";
import { readDiscordTokenStore } from "./discord-config.mjs";
import {
  PcmTurnBuffer,
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

function logAudioFailure(logger, event, error) {
  try {
    logger.error?.({
      component: "discord-voice",
      event,
      errorName: error?.name ?? "Error",
    });
  } catch {
    // Audio cleanup must not depend on a logger implementation.
  }
}

function createDiscordPlayer(connection, logger = console) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  player.on("error", (error) => {
    logAudioFailure(logger, "playback_failed", error);
  });
  connection.subscribe(player);
  return async (ttsPcm, { signal } = {}) => {
    const stopOnAbort = () => player.stop(true);
    signal?.addEventListener("abort", stopOnAbort, { once: true });
    const raw = ttsPcm24kMonoToDiscordRaw(ttsPcm);
    const seconds = raw.length / PCM_BYTES_PER_SECOND;
    const resource = createAudioResource(Readable.from(raw), {
      inputType: StreamType.Raw,
    });
    try {
      player.play(resource);
      await entersState(player, AudioPlayerStatus.Playing, 5_000);
      await entersState(
        player,
        AudioPlayerStatus.Idle,
        Math.max(10_000, Math.ceil(seconds * 1_000) + 10_000),
      );
    } finally {
      signal?.removeEventListener("abort", stopOnAbort);
    }
  };
}

export function subscribeToAllowedSpeaker({
  connection,
  config,
  session,
  postText,
  logger,
  createDecoder = (options) => new prism.opus.Decoder(options),
}) {
  const active = new Set();
  const notify = (content) =>
    Promise.resolve()
      .then(() => postText(content))
      .catch(() => undefined);
  connection.receiver.speaking.on("start", (userId) => {
    if (userId !== config.allowedUserId || active.has(userId)) return;
    active.add(userId);
    const opusStream = connection.receiver.subscribe(userId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: config.silenceMs,
      },
    });
    const decoder = createDecoder({
      rate: 48_000,
      channels: 2,
      frameSize: 960,
    });
    const turnBuffer = new PcmTurnBuffer(config);

    decoder.on("data", (chunk) => {
      if (!turnBuffer.push(chunk)) {
        active.delete(userId);
        opusStream.destroy();
        decoder.destroy();
        void notify(
          `⚠️ 発話が${config.maximumAudioSeconds}秒を超えたため破棄しました。`,
        );
        return;
      }
    });
    const release = () => active.delete(userId);
    opusStream.once("error", (error) => {
      release();
      decoder.destroy();
      logAudioFailure(logger, "receive_failed", error);
    });
    opusStream.once("close", release);
    decoder.once("close", release);
    decoder.once("error", (error) => {
      release();
      opusStream.destroy();
      logAudioFailure(logger, "decode_failed", error);
    });
    decoder.once("end", () => {
      release();
      const completed = turnBuffer.finish();
      if (completed.status !== "accepted") return;
      if (!session.enqueue(wrapPcmAsWav(completed.pcm), { userId })) {
        void notify(
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
  dependencies = {},
} = {}) {
  // Build local adapters before Discord login so unsafe Codex configuration
  // fails closed without joining or sending to a channel.
  const audio = dependencies.audioAdapter ?? createOpenAIAudioAdapter(config);
  const codex = dependencies.codexRunner ?? new CodexVoiceRunner(config);
  await codex.prepare?.();
  const credential = await (
    dependencies.readCredential ?? readDiscordTokenStore
  )();
  const ready = client.isReady()
    ? Promise.resolve()
    : once(client, Events.ClientReady);
  await client.login(credential.token);
  await ready;
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
  const connection = (dependencies.joinVoiceChannel ?? joinVoiceChannel)({
    channelId: voiceChannel.id,
    guildId: guild.id,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: false,
  });
  await (dependencies.entersState ?? entersState)(
    connection,
    VoiceConnectionStatus.Ready,
    20_000,
  );
  const session = new DiscordVoiceSession({
    transcribe: audio.transcribe,
    runCodex: (transcript, options) => codex.run(transcript, options),
    synthesize: audio.synthesize,
    postText,
    playAudio:
      dependencies.playAudio ?? createDiscordPlayer(connection, logger),
    logger,
    maximumQueuedTurns: config.maximumQueuedTurns,
    stageTimeouts: config.stageTimeouts,
  });
  subscribeToAllowedSpeaker({
    connection,
    config,
    session,
    postText,
    logger,
    createDecoder: dependencies.createDecoder,
  });
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
