import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ChannelType } from "discord.js";
import {
  startDiscordVoiceCodex,
  subscribeToAllowedSpeaker,
} from "../src/discord-voice-server.mjs";

test("voice receiver subscribes only to the configured owner", () => {
  const speaking = new EventEmitter();
  const decoder = new EventEmitter();
  decoder.destroy = () => decoder.emit("close");
  let subscriptions = 0;
  const connection = {
    receiver: {
      speaking,
      subscribe: () => {
        subscriptions += 1;
        const stream = new EventEmitter();
        stream.pipe = () => decoder;
        stream.destroy = () => undefined;
        return stream;
      },
    },
  };
  subscribeToAllowedSpeaker({
    connection,
    config: {
      allowedUserId: "44444444444444444",
      silenceMs: 1_000,
      minimumAudioMs: 250,
      maximumAudioSeconds: 90,
    },
    session: { enqueue: () => true },
    postText: async () => undefined,
    logger: { error: () => undefined },
    createDecoder: () => decoder,
  });
  speaking.emit("start", "99999999999999999");
  assert.equal(subscriptions, 0);
  speaking.emit("start", "44444444444444444");
  speaking.emit("start", "44444444444444444");
  assert.equal(subscriptions, 1);
});

test("a Discord receive stream error is contained without exposing details", () => {
  const speaking = new EventEmitter();
  const opusStream = new EventEmitter();
  const decoder = new EventEmitter();
  let decoderDestroyed = false;
  decoder.destroy = () => {
    decoderDestroyed = true;
    decoder.emit("close");
  };
  opusStream.pipe = () => decoder;
  opusStream.destroy = () => undefined;
  const logs = [];
  subscribeToAllowedSpeaker({
    connection: {
      receiver: {
        speaking,
        subscribe: () => opusStream,
      },
    },
    config: {
      allowedUserId: "44444444444444444",
      silenceMs: 1_000,
      minimumAudioMs: 250,
      maximumAudioSeconds: 90,
    },
    session: { enqueue: () => true },
    postText: async () => undefined,
    logger: {
      error: (entry) => {
        logs.push(entry);
        throw new Error("logger failure");
      },
    },
    createDecoder: () => decoder,
  });
  speaking.emit("start", "44444444444444444");
  assert.doesNotThrow(() =>
    opusStream.emit("error", new Error("secret receive detail")),
  );
  assert.equal(decoderDestroyed, true);
  assert.equal(logs[0].event, "receive_failed");
  assert.doesNotMatch(JSON.stringify(logs), /secret receive detail/);
});

test("voice server logs in, validates targets, joins undeafened, and announces AI audio", async () => {
  const sent = [];
  const joins = [];
  const voiceChannel = {
    id: "22222222222222222",
    type: ChannelType.GuildVoice,
  };
  const textChannel = {
    isTextBased: () => true,
    send: async (payload) => sent.push(payload),
  };
  const guild = {
    id: "11111111111111111",
    voiceAdapterCreator: {},
    channels: {
      fetch: async (id) =>
        id === voiceChannel.id ? voiceChannel : textChannel,
    },
  };
  const calls = [];
  const client = {
    isReady: () => true,
    login: async (token) => calls.push(["login", token]),
    guilds: { fetch: async (id) => (calls.push(["guild", id]), guild) },
    destroy: () => calls.push(["destroy"]),
  };
  const connection = {
    receiver: { speaking: new EventEmitter() },
    destroy: () => calls.push(["disconnect"]),
  };
  const config = {
    guildId: guild.id,
    voiceChannelId: voiceChannel.id,
    textChannelId: "33333333333333333",
    allowedUserId: "44444444444444444",
    workingDirectory: "/tmp/workspace",
    statePath: "/tmp/state",
    sttModel: "gpt-transcribe",
    ttsModel: "gpt-4o-mini-tts",
    ttsVoice: "marin",
    codexModel: undefined,
    codexHome: undefined,
    isolatedCodexHome: "/tmp/isolated-codex-home",
    codexSandbox: "workspace-write",
    silenceMs: 1_000,
    minimumAudioMs: 250,
    maximumAudioSeconds: 90,
    maximumQueuedTurns: 3,
    stageTimeouts: {
      transcribing: 120_000,
      running_codex: 900_000,
      posting: 30_000,
      synthesizing: 120_000,
      speaking: 300_000,
    },
    openaiApiKey: "test-key",
  };
  const service = await startDiscordVoiceCodex({
    config,
    client,
    logger: { info: () => undefined },
    dependencies: {
      readCredential: async () => ({ token: "bot-test-token" }),
      joinVoiceChannel: (options) => (joins.push(options), connection),
      entersState: async () => connection,
      audioAdapter: {
        transcribe: async () => "",
        synthesize: async () => Buffer.alloc(0),
      },
      codexRunner: {
        prepare: async () => calls.push(["prepare"]),
        run: async () => "",
      },
      playAudio: async () => undefined,
    },
  });
  assert.deepEqual(calls[0], ["prepare"]);
  assert.deepEqual(calls[1], ["login", "bot-test-token"]);
  assert.equal(joins[0].channelId, voiceChannel.id);
  assert.equal(joins[0].selfDeaf, false);
  assert.equal(joins[0].selfMute, false);
  assert.match(sent[0].content, /AI生成/);
  assert.deepEqual(sent[0].allowedMentions, { parse: [] });
  assert.equal(service.session.stageTimeouts.running_codex, 900_000);
  await service.stop();
  assert.ok(calls.some(([kind]) => kind === "disconnect"));
  assert.ok(calls.some(([kind]) => kind === "destroy"));
});

test("voice server validates Codex isolation before reading or using Discord credentials", async () => {
  let credentialRead = false;
  let loginCalled = false;
  await assert.rejects(
    () =>
      startDiscordVoiceCodex({
        config: {},
        client: {
          isReady: () => true,
          login: async () => {
            loginCalled = true;
          },
        },
        dependencies: {
          audioAdapter: {},
          codexRunner: {
            prepare: async () => {
              throw new Error("unsafe Codex configuration");
            },
          },
          readCredential: async () => {
            credentialRead = true;
            return { token: "must-not-be-read" };
          },
        },
      }),
    /unsafe Codex configuration/,
  );
  assert.equal(credentialRead, false);
  assert.equal(loginCalled, false);
});
