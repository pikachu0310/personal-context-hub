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
const AUDIO_RETRY_MESSAGE =
  "⚠️ 音声データを処理できませんでした。もう一度話してください。";

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

function logInfoQuietly(logger, entry) {
  try {
    logger.info?.(entry);
  } catch {
    // Logging must never change service readiness or cleanup semantics.
  }
}

async function destroyQuietly(resource) {
  try {
    await resource?.destroy?.();
  } catch {
    // Cleanup must preserve the original startup failure or shutdown signal.
  }
}

export function createDiscordPlayer(connection, logger = console) {
  const player = createAudioPlayer({
    behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
  });
  player.on("error", (error) => {
    logAudioFailure(logger, "playback_failed", error);
  });
  connection.subscribe(player);
  return async (ttsPcm, { signal } = {}) => {
    if (signal?.aborted) throw signal.reason;
    const stopOnAbort = () => player.stop(true);
    signal?.addEventListener("abort", stopOnAbort, { once: true });
    try {
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
    let discardedTurn = false;
    let finalized = false;

    decoder.on("data", (chunk) => {
      if (discardedTurn) return;
      try {
        if (turnBuffer.push(chunk)) return;
        discardedTurn = true;
        active.delete(userId);
        opusStream.destroy();
        decoder.destroy();
        void notify(
          `⚠️ 発話が${config.maximumAudioSeconds}秒を超えたため破棄しました。`,
        );
      } catch (error) {
        discardedTurn = true;
        active.delete(userId);
        opusStream.destroy();
        decoder.destroy();
        logAudioFailure(logger, "receive_frame_failed", error);
        void notify(AUDIO_RETRY_MESSAGE);
      }
    });
    const release = () => active.delete(userId);
    opusStream.once("error", (error) => {
      discardedTurn = true;
      finalized = true;
      release();
      decoder.destroy();
      logAudioFailure(logger, "receive_failed", error);
      void notify(AUDIO_RETRY_MESSAGE);
    });
    opusStream.once("close", release);
    decoder.once("close", release);
    decoder.once("error", (error) => {
      discardedTurn = true;
      finalized = true;
      release();
      opusStream.destroy();
      logAudioFailure(logger, "decode_failed", error);
      void notify(AUDIO_RETRY_MESSAGE);
    });
    decoder.once("end", () => {
      if (finalized) return;
      finalized = true;
      release();
      if (discardedTurn) return;
      try {
        const completed = turnBuffer.finish();
        if (completed.status !== "accepted") return;
        if (!session.enqueue(wrapPcmAsWav(completed.pcm), { userId })) {
          void notify(
            "⚠️ 音声ターンが混雑しています。少し待ってからもう一度話してください。",
          );
        }
      } catch (error) {
        logAudioFailure(logger, "receive_finalize_failed", error);
        void notify(AUDIO_RETRY_MESSAGE);
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
  let connection;
  let loginAttempted = false;
  try {
    client.on?.(Events.Error, (error) => {
      logAudioFailure(logger, "discord_client_failed", error);
    });
    const ready = client.isReady()
      ? Promise.resolve()
      : once(client, Events.ClientReady);
    loginAttempted = true;
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
    connection = (dependencies.joinVoiceChannel ?? joinVoiceChannel)({
      channelId: voiceChannel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
    connection.on?.("error", (error) => {
      logAudioFailure(logger, "voice_connection_failed", error);
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
    logInfoQuietly(logger, {
      component: "discord-voice",
      event: "ready",
      ...describeDiscordVoiceConfig(config),
    });
    let stopped = false;
    return {
      client,
      connection,
      session,
      async stop() {
        if (stopped) return;
        stopped = true;
        session.stop();
        await Promise.all([destroyQuietly(connection), destroyQuietly(client)]);
      },
    };
  } catch (error) {
    await Promise.all([
      destroyQuietly(connection),
      loginAttempted ? destroyQuietly(client) : Promise.resolve(),
    ]);
    throw error;
  }
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
