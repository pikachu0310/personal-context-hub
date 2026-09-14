import { createAudioPlayer, type VoiceConnection } from "@discordjs/voice";
import type { Client } from "discord.js";
import { randomUUID } from "node:crypto";
export interface DiscordState {
  config: Record<string, string>;
  client?: Client;
  voice?: VoiceConnection;
  speechEpoch: number;
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
    audioSessionId: randomUUID(),
    activeSpeakers: new Set(),
    player: createAudioPlayer(),
    pending: new Map(),
  };
}
