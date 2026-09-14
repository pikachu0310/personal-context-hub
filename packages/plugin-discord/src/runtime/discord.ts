import { VoiceConnectionStatus } from "@discordjs/voice";
import { randomUUID } from "node:crypto";
import type { PluginEvent, PluginOutput } from "@ido/common/contracts/plugins";
import { pluginRuntime } from "@ido/common/runtime/plugin";
import { DiscordWeb } from "../activity/server.js";
import { inspectSetup } from "../input/setup.js";
import { start } from "../input/connection.js";
import { normalizeInput } from "../input/normalize.js";
import { normalizeDiscordPolicy } from "../input/policy.js";
import { discordManifest } from "../manifest.js";
import { Publications } from "../output/publications.js";
import { renderPublication } from "../output/render.js";
import { deliver } from "../output/transport.js";
import { audioOutput } from "../output/audio.js";
import { createDiscordState } from "./state.js";
import type { Task } from "@ido/common/contracts/protocol";
import {
  ForumSync,
  forumKey,
  type ForumBinding,
  type ForumRecord,
} from "../forum/sync.js";
import { forumTransport } from "../forum/transport.js";
import { connectionLink, validateDownloads } from "../onboarding/guide.js";
const state = createDiscordState();
let forumTimer: NodeJS.Timeout | undefined;
let forumBusy = false;
async function refreshForum() {
  const forum = state.forum;
  if (!forum || forumBusy || !state.client?.isReady()) return;
  forumBusy = true;
  try {
    const tasks = await runtime.rpc.request<Task[]>("tasks.snapshot", {});
    if (state.forum === forum) await forum.sync(tasks);
  } catch {
    runtime.emit("status", { status: "forum-sync-error" });
  } finally {
    forumBusy = false;
  }
}
function configureForum() {
  clearInterval(forumTimer);
  state.forum = undefined;
  if (
    !state.config.issueForumChannelId ||
    !state.client ||
    !state.config.projectId
  )
    return;
  const binding = { ...state.config } as unknown as ForumBinding;
  const key = forumKey(binding);
  const forum: ForumSync = new ForumSync(
    binding,
    forumTransport(state.client, binding, () => state.forum === forum),
    () =>
      runtime.rpc.request<ForumRecord[] | undefined>("storage.get", { key }),
    async (records) => {
      await runtime.rpc.request("storage.put", { key, value: records });
    },
    () => state.forum === forum,
  );
  state.forum = forum;
  forumTimer = setInterval(() => void refreshForum(), 10000);
  void refreshForum();
}
state.projectCommand = async (subject, projectId) => {
  if (projectId && projectId !== state.config.projectId) {
    const project = await runtime.rpc.request<
      import("@ido/common/contracts/protocol").Project
    >("projects.select", { subject, projectId });
    state.config.projectId = project.id;
    state.speechEpoch++;
    audioOutput(state).invalidate();
    for (const request of state.pending.values()) {
      clearTimeout(request.timer);
      request.reject();
    }
    state.pending.clear();
    configureForum();
  }
  return runtime.rpc.request("projects.list", { subject });
};
state.connectionGuide = async () => {
  const { origin } = await runtime.rpc.request<{ origin: string }>(
    "connection.info",
    {},
  );
  return `PCにIDO Agentをインストールして接続します。\n${connectionLink(origin)}\nWindows / Mac のダウンロードと起動手順を開けます。接続先の確認・ログイン・作業許可は各自のPCで行ってください。`;
};
const publications = new Publications(
  async (id) => state.client?.channels.fetch(id),
  async (key, messageId) => {
    await runtime.rpc.request("storage.put", { key, value: { messageId } });
  },
);
state.player.on("error", () => emit({ type: "status", status: "audio-error" }));
let pendingFrames = 0;
let lastInputAt: number | undefined;
let receivedAudioFrames = 0;
const emit = (data: Record<string, unknown>) => {
  if (data.type === "input") {
    const input = normalizeInput(
      data,
      state.config,
      state.voice?.state.status === VoiceConnectionStatus.Ready
        ? (state.voice.joinConfig.channelId ?? undefined)
        : undefined,
      state.audioSessionId,
      state.forum?.taskForThread(String(data.channelId)),
    );
    if (input) {
      lastInputAt = Date.now();
      if (input.audioFrame) receivedAudioFrames++;
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
    if (operation === "health")
      return {
        gatewayReady: state.client?.isReady() ?? false,
        voiceStatus: state.voice?.state.status ?? "disconnected",
        voiceChannelId: state.voice?.joinConfig.channelId,
        playbackStatus: state.player.state.status,
        activeSpeakers: state.activeSpeakers.size,
        pendingFrames,
        receivedAudioFrames,
        lastInputAt,
      };
    if (operation === "setup")
      return inspectSetup(input.config as Record<string, string>);
    if (operation === "validate") {
      validateDownloads(input.config as Record<string, string>);
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
      validateDownloads(next);
      state.forum = undefined;
      const reconnect = [
        "guildId",
        "textChannelId",
        "botToken",
        "appId",
        "voiceChannelId",
        "messageContentIntent",
      ].some((key) => next[key] !== state.config[key]);
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
      configureForum();
      return { ok: true };
    }
    if (operation === "start") {
      const next = input.config as Record<string, string>;
      normalizeDiscordPolicy(next);
      if (!next.botToken || !next.guildId || !next.textChannelId)
        throw new Error("DISCORD_CONFIG_REQUIRED");
      const setup = await inspectSetup(next);
      next.appId = setup.appId;
      await start(state, emit, next);
      configureForum();
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
      // Polling the authoritative snapshot coalesces frequent progress events,
      // retries failed edits and restores mappings after plugin restarts.
      if (event.type === "tasks") return { ok: true };
      if (
        (event.data as { projectId?: string }).projectId !==
          state.config.projectId ||
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
        (event.data as { projectId?: string }).projectId !==
          state.config.projectId
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
          (event.data as { projectId?: string }).projectId ===
            state.config.projectId,
      );
      return { ok: true };
    }
    throw new Error("UNKNOWN_OPERATION");
  },
  async () => {
    clearInterval(forumTimer);
    state.forum = undefined;
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
