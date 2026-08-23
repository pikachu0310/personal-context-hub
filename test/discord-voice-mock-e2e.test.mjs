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
  workingDirectory: "/tmp/mock-workspace",
  statePath: "/tmp/mock-state.json",
  sttModel: "gpt-transcribe",
  ttsModel: "gpt-4o-mini-tts",
  ttsVoice: "marin",
  codexModel: undefined,
  codexHome: undefined,
  isolatedCodexHome: "/tmp/mock-codex-home",
  codexSandbox: "workspace-write",
  silenceMs: 1_000,
  minimumAudioMs: 250,
  maximumAudioSeconds: 90,
  maximumQueuedTurns: 3,
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

test("synthetic owner PCM crosses receive, STT, Codex, Text, TTS, and playback", async () => {
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
      assert.equal(userId, config.allowedUserId);
      return opusStream;
    },
  };
  connection.destroy = async () => {
    connectionDestroyCalls += 1;
  };

  const voiceChannel = {
    id: config.voiceChannelId,
    type: ChannelType.GuildVoice,
  };
  const textChannel = {
    isTextBased: () => true,
    send: async (payload) => {
      posts.push(payload);
      if (payload.content.includes("Discord音声Codexを起動")) {
        return { id: "announcement" };
      }
      if (payload.content.includes("聞き取った内容")) {
        turnEvents.push("post_transcript");
      } else {
        turnEvents.push("post_response");
      }
      return { id: `message-${posts.length}` };
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
        run: async (transcript) => {
          turnEvents.push("codex");
          assert.equal(transcript, "モック発話");
          return "モック応答";
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
    },
  });

  speaking.emit("start", config.allowedUserId);
  decoder.emit("data", Buffer.alloc(48_000));
  decoder.emit("end");
  await eventually(
    () => service.session.state === "idle" && turnEvents.includes("playback"),
  );

  assert.deepEqual(decoderOptions, {
    rate: 48_000,
    channels: 2,
    frameSize: 960,
  });
  assert.deepEqual(turnEvents, [
    "stt",
    "post_transcript",
    "codex",
    "post_response",
    "tts",
    "playback",
  ]);
  assert.equal(posts.length, 3);
  assert.match(posts[0].content, /本人allowlist/);
  assert.match(posts[1].content, /モック発話/);
  assert.equal(posts[2].content, "モック応答");
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
