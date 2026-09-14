import { createAudioPlayer, type VoiceConnection } from "@discordjs/voice";
import type { Client } from "discord.js";
export interface DiscordState {
  config: Record<string, string>;
  client?: Client;
  voice?: VoiceConnection;
  speechEpoch: number;
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
    player: createAudioPlayer(),
    pending: new Map(),
  };
}
