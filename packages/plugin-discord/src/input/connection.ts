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
  MessageFlags,
  type VoiceChannel,
} from "discord.js";
import prism from "prism-media";
import { randomUUID } from "node:crypto";
import { text } from "@ido/common/contracts/protocol";
import {
  registerVoiceCommands,
  voiceCommandHandler,
} from "../commands/voice.js";
import { discordUserAllowed } from "../input/policy.js";
import { VoiceCapture } from "./capture.js";
import { audioOutput } from "../output/audio.js";
import type { DiscordState } from "../runtime/state.js";
import { forumCommand } from "../forum/sync.js";
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
      message.webhookId ||
      !discordUserAllowed(state.config, message.author.id) ||
      message.guildId !== state.config.guildId
    )
      return;
    const forumTask =
      message.channel.isThread() &&
      message.channel.parentId === state.config.issueForumChannelId
        ? state.forum?.taskForThread(message.channelId)
        : undefined;
    if (!forumTask && message.channelId !== state.config.textChannelId) return;
    const task = !forumTask && message.content.startsWith("!ido task ");
    const content = task ? message.content.slice(10) : message.content;
    if (!content.trim()) return;
    emit({
      type: "input",
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      eventId: message.id,
      text: content,
      command: forumTask ? forumCommand(content) : task ? "task" : "message",
      taskId: forumTask,
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
      state.audioSessionId = randomUUID();
      audioOutput(state).invalidate();
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
        audioOutput(state).speakerStart(userId);
        const capture = new VoiceCapture(
          {
            sessionId: state.audioSessionId,
            userId,
            guildId: channel.guild.id,
            channelId: channel.id,
            meetingId: state.config.meetingId,
            projectId: state.config.projectId,
            speechEpoch: receivedEpoch,
          },
          emit,
        );
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
        let finished = false;
        const finish = (complete = true) => {
          if (finished) return;
          finished = true;
          capture.finish(complete);
          audioOutput(state).speakerEnd(userId);
          active.delete(userId);
        };
        stream.pipe(decoder);
        decoder.on("data", (chunk: Buffer) => {
          try {
            capture.push(chunk);
          } catch {
            stream.destroy();
            decoder.destroy();
          }
        });
        stream.on("error", () => {
          finish(false);
          decoder.destroy();
        });
        decoder.on("error", () => finish(false));
        stream.once("close", () => {
          streams.delete(stream);
        });
        decoder.once("end", () => finish(true));
        decoder.once("close", () => finish(false));
      });
    },
    () => {
      const previous = state.voice;
      state.voice = undefined;
      state.speechEpoch++;
      state.audioSessionId = randomUUID();
      audioOutput(state).invalidate();
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
      connect: () =>
        state.connectionGuide?.() ?? Promise.resolve("接続案内は準備中です。"),
      allowed: (userId) => discordUserAllowed(state.config, userId),
      quiet: (userId) => {
        state.speechEpoch++;
        audioOutput(state).invalidate();
        emit({
          type: "input",
          activity: "quiet",
          userId,
          eventId: randomUUID(),
          guildId: state.config.guildId,
          channelId: state.voice?.joinConfig.channelId,
          speechEpoch: state.speechEpoch,
          capture: {
            sessionId: state.audioSessionId,
            utteranceId: randomUUID(),
            segmentIndex: 0,
            startedAt: Date.now(),
          },
        });
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
    if (
      (interaction.isAutocomplete() || interaction.isChatInputCommand()) &&
      interaction.commandName === "project"
    ) {
      void (async () => {
        const allowed =
          interaction.guildId === state.config.guildId &&
          discordUserAllowed(state.config, interaction.user.id);
        if (interaction.isAutocomplete()) {
          if (!allowed) {
            await interaction.respond([]);
            return;
          }
          try {
            const listing = await state.projectCommand!(interaction.user.id);
            const query = interaction.options.getFocused().toLowerCase();
            await interaction.respond(
              listing.projects
                .filter((p) => p.name.toLowerCase().includes(query))
                .slice(0, 25)
                .map((p) => ({ name: p.name, value: p.id })),
            );
          } catch {
            await interaction.respond([]);
          }
        } else {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          try {
            if (!allowed) throw new Error("PERMISSION_DENIED");
            const listing = await state.projectCommand!(
              interaction.user.id,
              interaction.options.getString("name") ?? undefined,
            );
            await interaction.editReply({
              content: `現在のプロジェクト: ${listing.projects.find((p) => p.id === listing.projectId)?.name ?? listing.projectId}`,
              allowedMentions: { parse: [] },
            });
          } catch {
            await interaction.editReply(
              "切り替えできません。受付権限を確認し、候補から既存プロジェクトを選んでください。",
            );
          }
        }
      })().catch(() =>
        emit({ type: "status", status: "project-command-error" }),
      );
      return;
    }
    if (interaction.isChatInputCommand())
      void handleCommand(interaction).catch(() =>
        emit({ type: "status", status: "command-error" }),
      );
  });
  state.client.once(Events.ClientReady, () => {
    void (async () => {
      state.config.appId = state.client!.application!.id;
      const guild = await state.client!.guilds.fetch(state.config.guildId);
      await registerVoiceCommands(guild);
      emit({ type: "status", status: "connected" });
    })().catch(() =>
      emit({ type: "status", status: "command-registration-failed" }),
    );
  });
  await state.client.login(text(state.config.botToken, 4000));
}
