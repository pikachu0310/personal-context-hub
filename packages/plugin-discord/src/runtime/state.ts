import { createAudioPlayer, type VoiceConnection } from "@discordjs/voice";
import type { Client } from "discord.js";
import { randomUUID } from "node:crypto";
import type { ForumSync } from "../forum/sync.js";
export interface DiscordState {
  config: Record<string, string>;
  client?: Client;
  forum?: ForumSync;
  projectCommand?: (
    subject: string,
    projectId?: string,
  ) => Promise<{
    projects: import("@ido/common/contracts/protocol").Project[];
    projectId: string;
  }>;
  refreshTranscript?: () => Promise<void>;
  connectionGuide?: () => Promise<string>;
  voice?: VoiceConnection;
  speechEpoch: number;
  playbackRevision: number;
  audioSessionId: string;
  activeSpeakers: Set<string>;
  player: ReturnType<typeof createAudioPlayer>;
  pending: Map<
    string,
    {
      resolve(value: { content: string; file?: string }): void;
      reject(): void;
      timer: NodeJS.Timeout;
    }
  >;
}
export function createDiscordState(): DiscordState {
  return {
    config: {},
    speechEpoch: 0,
    playbackRevision: 0,
    audioSessionId: randomUUID(),
    activeSpeakers: new Set(),
    player: createAudioPlayer(),
    pending: new Map(),
  };
}
