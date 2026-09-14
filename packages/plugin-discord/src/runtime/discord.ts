import { VoiceConnectionStatus } from "@discordjs/voice";
import { randomUUID } from "node:crypto";
import type { PluginEvent, PluginOutput } from "@ido/common/contracts/plugins";
import { pluginRuntime } from "@ido/common/runtime/plugin";
import { DiscordWeb } from "../activity/server.js";
import { start } from "../input/connection.js";
import { normalizeInput } from "../input/normalize.js";
import { normalizeDiscordPolicy } from "../input/policy.js";
import { discordManifest } from "../manifest.js";
import { Publications } from "../output/publications.js";
import { renderPublication } from "../output/render.js";
import { deliver } from "../output/transport.js";
import { audioOutput } from "../output/audio.js";
import { createDiscordState } from "./state.js";
const state = createDiscordState();
const publications = new Publications(
  async (id) => state.client?.channels.fetch(id),
  async (key, messageId) => {
    await runtime.rpc.request("storage.put", { key, value: { messageId } });
  },
);
state.player.on("error", () => emit({ type: "status", status: "audio-error" }));
let pendingFrames = 0;
const emit = (data: Record<string, unknown>) => {
  if (data.type === "input") {
    const input = normalizeInput(
      data,
      state.config,
      state.voice?.state.status === VoiceConnectionStatus.Ready
        ? (state.voice.joinConfig.channelId ?? undefined)
        : undefined,
      state.audioSessionId,
    );
    if (input) {
      if (input.audioFrame && pendingFrames >= 32) return;
      if (input.audioFrame) pendingFrames++;
      void runtime.rpc
        .request("input", input as unknown as Record<string, unknown>)
        .catch(() => runtime.emit("status", { status: "input-error" }))
        .finally(() => {
          if (input.audioFrame) pendingFrames--;
        });
    }
  } else if (data.type === "voice") runtime.emit("invalidate");
  else runtime.emit(String(data.type), data);
};

const web = new DiscordWeb(
  () => state.config,
  () => runtime.rpc,
);
const runtime = pluginRuntime(
  discordManifest,
  async (operation, input) => {
    if (operation === "validate") {
      return {
        config: {
          ...(input.config as Record<string, string>),
          ...normalizeDiscordPolicy(input.config as Record<string, string>),
        },
      };
    }
    if (operation === "configure") {
      const next = {
        ...state.config,
        ...(input.config as Record<string, string>),
      };
      normalizeDiscordPolicy(next);
      const reconnect = ["guildId", "textChannelId", "botToken", "appId"].some(
        (key) => next[key] !== state.config[key],
      );
      Object.assign(state.config, next);
      discordManifest.web!.frameOrigins = [
        `https://${state.config.appId}.discordsays.com`,
      ];
      state.speechEpoch++;
      state.audioSessionId = randomUUID();
      audioOutput(state).invalidate();
      runtime.emit("invalidate");
      if (reconnect) {
        for (const request of state.pending.values()) {
          clearTimeout(request.timer);
          request.reject();
        }
        state.pending.clear();
        if (
          state.voice &&
          state.voice.state.status !== VoiceConnectionStatus.Destroyed
        )
          state.voice.destroy();
        state.voice = undefined;
        state.client?.destroy();
        await start(state, emit, next);
      }
      return { ok: true };
    }
    if (operation === "start") {
      const next = input.config as Record<string, string>;
      normalizeDiscordPolicy(next);
      if (!next.botToken || !next.guildId || !next.textChannelId)
        throw new Error("DISCORD_CONFIG_REQUIRED");
      await start(state, emit, next);
      discordManifest.web!.frameOrigins = [
        `https://${state.config.appId}.discordsays.com`,
      ];
      return { port: await web.start() };
    }
    if (operation === "output") {
      const output = input.output as unknown as PluginOutput;
      if (output.replyTo?.interaction && output.kind === "reply") {
        const request = state.pending.get(output.eventId);
        if (request) {
          clearTimeout(request.timer);
          state.pending.delete(output.eventId);
          request.resolve({ content: output.content ?? "", file: output.file });
        }
        return { ok: true };
      }
      await deliver(state, {
        kind: output.kind,
        eventId: output.eventId,
        channelId: output.replyTo?.channelId,
        content: output.content,
        audio: output.audio,
        speechEpoch: output.replyTo?.speechEpoch,
        audioSessionId: output.replyTo?.audioSessionId,
        audioFormat: output.audioFormat,
        candidateId: output.candidateId,
        audioSequence: output.audioSequence,
      });
      return { ok: true };
    }
    if (operation === "event") {
      const event = input.event as unknown as PluginEvent;
      if (
        event.meetingId !== state.config.meetingId ||
        !["transcript", "minutes"].includes(event.type)
      )
        return { ok: true };
      const epoch = state.speechEpoch;
      const channelId = state.config.textChannelId;
      const key = `${event.type}-${event.meetingId}-${state.config.textChannelId}`;
      const saved = await runtime.rpc.request<
        { messageId?: string } | undefined
      >("storage.get", { key });
      if (
        epoch !== state.speechEpoch ||
        channelId !== state.config.textChannelId ||
        event.meetingId !== state.config.meetingId
      )
        return { ok: true };
      await publications.update(
        key,
        state.config.textChannelId,
        renderPublication(event),
        saved?.messageId,
        () =>
          epoch === state.speechEpoch &&
          channelId === state.config.textChannelId &&
          event.meetingId === state.config.meetingId,
      );
      return { ok: true };
    }
    throw new Error("UNKNOWN_OPERATION");
  },
  async () => {
    for (const request of state.pending.values()) {
      clearTimeout(request.timer);
      request.reject();
    }
    state.pending.clear();
    if (
      state.voice &&
      state.voice.state.status !== VoiceConnectionStatus.Destroyed
    )
      state.voice.destroy();
    audioOutput(state).invalidate();
    state.client?.destroy();
    await web.close();
  },
);
