import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ChannelType } from "discord.js";
import { startDiscordVoiceCodex } from "../src/discord-voice-server.mjs";

const config = Object.freeze({
  guildId: "11111111111111111",
  voiceChannelId: "22222222222222222",
  textChannelId: "33333333333333333",
  allowedUserId: "44444444444444444",
  listenToEveryone: true,
  voiceMode: "meeting",
  workingDirectory: "/tmp/mock-workspace",
  statePath: "/tmp/mock-state.json",
  sttModel: "gpt-transcribe",
  ttsModel: "gpt-4o-mini-tts",
  ttsVoice: "marin",
  ttsSpeed: 2,
  codexModel: undefined,
  codexHome: undefined,
  isolatedCodexHome: "/tmp/mock-codex-home",
  codexSandbox: "workspace-write",
  silenceMs: 1_000,
  minimumAudioMs: 250,
  maximumAudioSeconds: 90,
  maximumQueuedTurns: 3,
  maximumPendingTranscriptions: 60,
  transcriptionConcurrency: 4,
  observationIntervalMs: 60_000,
  stageTimeouts: {
    transcribing: 1_000,
    running_codex: 1_000,
    posting: 1_000,
    synthesizing: 1_000,
    speaking: 1_000,
  },
  openaiApiKey: "mock-only-key",
});

async function eventually(check, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("mock voice vertical did not complete");
}

test("synthetic participant PCM crosses receive, STT, Codex, Text, TTS, and playback", async () => {
  const turnEvents = [];
  const posts = [];
  const speaking = new EventEmitter();
  const opusStream = new EventEmitter();
  const decoder = new EventEmitter();
  const connection = new EventEmitter();
  let connectionDestroyCalls = 0;
  let clientDestroyCalls = 0;
  let decoderOptions;

  decoder.destroy = () => decoder.emit("close");
  opusStream.pipe = (destination) => destination;
  opusStream.destroy = () => opusStream.emit("close");
  connection.receiver = {
    speaking,
    subscribe: (userId) => {
      assert.equal(userId, "55555555555555555");
      return opusStream;
    },
  };
  connection.destroy = async () => {
    connectionDestroyCalls += 1;
  };

  const voiceChannel = {
    id: config.voiceChannelId,
    type: ChannelType.GuildVoice,
    members: new Map([["55555555555555555", { displayName: "Guest" }]]),
  };
  const textChannel = {
    isTextBased: () => true,
    send: async (payload) => {
      posts.push(payload);
      if (payload.content === "モック応答") turnEvents.push("post_response");
      const message = {
        id: `message-${posts.length}`,
        edit: async (edited) => {
          posts.push(edited);
          return message;
        },
      };
      return message;
    },
  };
  const guild = {
    id: config.guildId,
    voiceAdapterCreator: {},
    channels: {
      fetch: async (channelId) => {
        if (channelId === config.voiceChannelId) return voiceChannel;
        if (channelId === config.textChannelId) return textChannel;
        assert.fail(`unexpected channel lookup: ${channelId}`);
      },
    },
  };
  const client = new EventEmitter();
  client.isReady = () => true;
  client.login = async (token) => {
    assert.equal(token, "mock-discord-token");
  };
  client.guilds = {
    fetch: async (guildId) => {
      assert.equal(guildId, config.guildId);
      return guild;
    },
  };
  client.destroy = async () => {
    clientDestroyCalls += 1;
  };

  const synthesized = Buffer.from("mock-tts-pcm");
  const service = await startDiscordVoiceCodex({
    config,
    client,
    logger: { info: () => undefined, error: () => undefined },
    dependencies: {
      audioAdapter: {
        transcribe: async (wav) => {
          turnEvents.push("stt");
          assert.equal(wav.subarray(0, 4).toString("ascii"), "RIFF");
          assert.equal(wav.subarray(8, 12).toString("ascii"), "WAVE");
          assert.equal(wav.readUInt32LE(40), 48_000);
          return "モック発話";
        },
        synthesize: async (text) => {
          turnEvents.push("tts");
          assert.equal(text, "モック応答");
          return synthesized;
        },
      },
      codexRunner: {
        prepare: async () => undefined,
        observeMeeting: async ({ transcript }) => {
          turnEvents.push("codex");
          assert.equal(transcript, "[Guest] モック発話");
          return JSON.stringify({
            minutes: "- Guestがモック発話",
            shouldReply: true,
            reply: "モック応答",
          });
        },
      },
      readCredential: async () => ({ token: "mock-discord-token" }),
      joinVoiceChannel: (options) => {
        assert.deepEqual(
          {
            channelId: options.channelId,
            guildId: options.guildId,
            selfDeaf: options.selfDeaf,
            selfMute: options.selfMute,
          },
          {
            channelId: config.voiceChannelId,
            guildId: config.guildId,
            selfDeaf: false,
            selfMute: false,
          },
        );
        return connection;
      },
      entersState: async (resource) => {
        assert.equal(resource, connection);
        return resource;
      },
      createDecoder: (options) => {
        decoderOptions = options;
        return decoder;
      },
      playAudio: async (audio) => {
        turnEvents.push("playback");
        assert.equal(audio, synthesized);
      },
      scheduleInterval: () => ({ unref: () => undefined }),
      cancelInterval: () => undefined,
    },
  });

  speaking.emit("start", "55555555555555555");
  decoder.emit("data", Buffer.alloc(48_000));
  decoder.emit("end");
  await eventually(() => service.session.statements.length === 1);
  assert.equal(await service.session.observeNow(), true);

  assert.deepEqual(decoderOptions, {
    rate: 48_000,
    channels: 2,
    frameSize: 960,
  });
  assert.deepEqual(turnEvents, [
    "stt",
    "codex",
    "post_response",
    "tts",
    "playback",
  ]);
  assert.ok(posts.some(({ content }) => /会議観測モード/.test(content)));
  assert.ok(posts.some(({ content }) => /Guest.*モック発話/.test(content)));
  assert.ok(posts.some(({ content }) => /議事録/.test(content)));
  assert.ok(posts.some(({ content }) => content === "モック応答"));
  assert.ok(
    posts.every(
      ({ allowedMentions }) =>
        Array.isArray(allowedMentions?.parse) &&
        allowedMentions.parse.length === 0,
    ),
  );

  await service.stop();
  await service.stop();
  assert.equal(connectionDestroyCalls, 1);
  assert.equal(clientDestroyCalls, 1);

  console.log(
    JSON.stringify({
      marker: "VOICE_CODEX_MOCK_E2E_OK",
      externalCalls: 0,
      stages: turnEvents,
    }),
  );
});
