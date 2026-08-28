import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ChannelType } from "discord.js";
import {
  createDiscordPlayer,
  startDiscordVoiceCodex,
  subscribeToAllowedSpeaker,
} from "../src/discord-voice-server.mjs";

function makeVoiceConfig(overrides = {}) {
  return {
    guildId: "11111111111111111",
    voiceChannelId: "22222222222222222",
    textChannelId: "33333333333333333",
    allowedUserId: "44444444444444444",
    listenToEveryone: false,
    workingDirectory: "/tmp/workspace",
    statePath: "/tmp/state",
    sttModel: "gpt-transcribe",
    ttsModel: "gpt-4o-mini-tts",
    ttsVoice: "marin",
    ttsSpeed: 1,
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
    ...overrides,
  };
}

test("voice player contains playback errors and rejects pre-cancelled work", async () => {
  let player;
  const logs = [];
  const play = createDiscordPlayer(
    { subscribe: (created) => (player = created) },
    { error: (entry) => logs.push(entry) },
  );
  assert.doesNotThrow(() =>
    player.emit("error", new Error("secret playback detail")),
  );
  assert.deepEqual(logs, [
    {
      component: "discord-voice",
      event: "playback_failed",
      errorName: "Error",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /secret playback detail/);

  const cancelled = new AbortController();
  cancelled.abort(new Error("service stopped"));
  await assert.rejects(
    () => play(Buffer.alloc(2), { signal: cancelled.signal }),
    /service stopped/,
  );

  const listenerCalls = [];
  const observedSignal = {
    aborted: false,
    addEventListener: (event) => listenerCalls.push(["add", event]),
    removeEventListener: (event) => listenerCalls.push(["remove", event]),
  };
  await assert.rejects(
    () => play(Buffer.alloc(1), { signal: observedSignal }),
    /complete int16 samples/,
  );
  assert.deepEqual(listenerCalls, [
    ["add", "abort"],
    ["remove", "abort"],
  ]);
});

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

test("voice receiver subscribes to another participant in all-speaker mode", () => {
  const speaking = new EventEmitter();
  const decoder = new EventEmitter();
  decoder.destroy = () => decoder.emit("close");
  const subscriptions = [];
  const connection = {
    receiver: {
      speaking,
      subscribe: (userId) => {
        subscriptions.push(userId);
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
      listenToEveryone: true,
      silenceMs: 1_000,
      minimumAudioMs: 250,
      maximumAudioSeconds: 90,
    },
    session: { enqueue: () => true },
    postText: async () => undefined,
    logger: { error: () => undefined },
    createDecoder: () => decoder,
  });
  speaking.emit("start", "55555555555555555");
  assert.deepEqual(subscriptions, ["55555555555555555"]);
});

test("a Discord receive stream error is contained without exposing details", async () => {
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
  const messages = [];
  let subscriptions = 0;
  subscribeToAllowedSpeaker({
    connection: {
      receiver: {
        speaking,
        subscribe: () => {
          subscriptions += 1;
          return opusStream;
        },
      },
    },
    config: {
      allowedUserId: "44444444444444444",
      silenceMs: 1_000,
      minimumAudioMs: 250,
      maximumAudioSeconds: 90,
    },
    session: { enqueue: () => true },
    postText: async (content) => messages.push(content),
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(messages, [
    "⚠️ 音声データを処理できませんでした。もう一度話してください。",
  ]);
  speaking.emit("start", "44444444444444444");
  assert.equal(subscriptions, 2);
});

test("a complete owner utterance is wrapped as WAV and queued once", () => {
  const speaking = new EventEmitter();
  const decoder = new EventEmitter();
  decoder.destroy = () => decoder.emit("close");
  const opusStream = new EventEmitter();
  opusStream.pipe = () => decoder;
  opusStream.destroy = () => undefined;
  const queued = [];
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
    session: {
      enqueue: (wav, metadata) => {
        queued.push({ wav, metadata });
        return true;
      },
    },
    postText: async () => undefined,
    logger: { error: () => undefined },
    createDecoder: () => decoder,
  });

  speaking.emit("start", "44444444444444444");
  decoder.emit("data", Buffer.alloc(48_000 * 2 * 2 * 0.25));
  decoder.emit("end");

  assert.equal(queued.length, 1);
  assert.equal(queued[0].wav.subarray(0, 4).toString("ascii"), "RIFF");
  assert.equal(queued[0].metadata.userId, "44444444444444444");
});

test("a decoder error is contained and tells the owner to retry", async () => {
  const speaking = new EventEmitter();
  const decoder = new EventEmitter();
  decoder.destroy = () => decoder.emit("close");
  const opusStream = new EventEmitter();
  opusStream.pipe = () => decoder;
  opusStream.destroy = () => undefined;
  const logs = [];
  const messages = [];
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
    postText: async (content) => messages.push(content),
    logger: { error: (entry) => logs.push(entry) },
    createDecoder: () => decoder,
  });

  speaking.emit("start", "44444444444444444");
  assert.doesNotThrow(() =>
    decoder.emit("error", new Error("private decoder detail")),
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(logs[0].event, "decode_failed");
  assert.doesNotMatch(JSON.stringify(logs), /private decoder detail/);
  assert.deepEqual(messages, [
    "⚠️ 音声データを処理できませんでした。もう一度話してください。",
  ]);
});

test("a decoder error cannot be followed by a duplicate queued turn", async () => {
  const speaking = new EventEmitter();
  const decoder = new EventEmitter();
  decoder.destroy = () => decoder.emit("close");
  const opusStream = new EventEmitter();
  opusStream.pipe = () => decoder;
  opusStream.destroy = () => undefined;
  const queued = [];
  const messages = [];
  subscribeToAllowedSpeaker({
    connection: {
      receiver: { speaking, subscribe: () => opusStream },
    },
    config: {
      allowedUserId: "44444444444444444",
      silenceMs: 1_000,
      minimumAudioMs: 250,
      maximumAudioSeconds: 90,
    },
    session: {
      enqueue: (wav) => (queued.push(wav), true),
    },
    postText: async (content) => messages.push(content),
    logger: { error: () => undefined },
    createDecoder: () => decoder,
  });

  speaking.emit("start", "44444444444444444");
  decoder.emit("error", new Error("decoder detail"));
  decoder.emit("end");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(queued.length, 0);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /音声データを処理できませんでした/);
});

test("a full voice queue reports bounded backpressure to the configured channel", async () => {
  const speaking = new EventEmitter();
  const decoder = new EventEmitter();
  decoder.destroy = () => decoder.emit("close");
  const opusStream = new EventEmitter();
  opusStream.pipe = () => decoder;
  opusStream.destroy = () => undefined;
  const messages = [];
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
    session: { enqueue: () => false },
    postText: async (content) => messages.push(content),
    logger: { error: () => undefined },
    createDecoder: () => decoder,
  });

  speaking.emit("start", "44444444444444444");
  decoder.emit("data", Buffer.alloc(48_000 * 2 * 2 * 0.25));
  decoder.emit("end");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(messages, [
    "⚠️ 音声ターンが混雑しています。少し待ってからもう一度話してください。",
  ]);
});

test("an oversized utterance is discarded and reported only once", async () => {
  const speaking = new EventEmitter();
  const decoder = new EventEmitter();
  decoder.destroy = () => decoder.emit("close");
  const opusStream = new EventEmitter();
  opusStream.pipe = () => decoder;
  opusStream.destroy = () => undefined;
  const messages = [];
  let enqueued = false;
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
      maximumAudioSeconds: 1,
    },
    session: {
      enqueue: () => {
        enqueued = true;
        return true;
      },
    },
    postText: async (content) => messages.push(content),
    logger: { error: () => undefined },
    createDecoder: () => decoder,
  });

  speaking.emit("start", "44444444444444444");
  const oversized = Buffer.alloc(48_000 * 2 * 2 + 4);
  decoder.emit("data", oversized);
  decoder.emit("data", oversized);
  decoder.emit("end");
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(enqueued, false);
  assert.deepEqual(messages, ["⚠️ 発話が1秒を超えたため破棄しました。"]);
});

test("a malformed decoded frame is contained and reported without crashing", async () => {
  const speaking = new EventEmitter();
  const decoder = new EventEmitter();
  decoder.destroy = () => decoder.emit("close");
  const opusStream = new EventEmitter();
  opusStream.pipe = () => decoder;
  opusStream.destroy = () => undefined;
  const messages = [];
  const logs = [];
  let enqueued = false;
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
    session: {
      enqueue: () => {
        enqueued = true;
        return true;
      },
    },
    postText: async (content) => messages.push(content),
    logger: { error: (entry) => logs.push(entry) },
    createDecoder: () => decoder,
  });

  speaking.emit("start", "44444444444444444");
  decoder.emit("data", Buffer.alloc(48_001));
  assert.doesNotThrow(() => decoder.emit("end"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(enqueued, false);
  assert.equal(logs[0].event, "receive_finalize_failed");
  assert.deepEqual(messages, [
    "⚠️ 音声データを処理できませんでした。もう一度話してください。",
  ]);
});

test("a non-buffer decoder frame is contained before finalization", async () => {
  const speaking = new EventEmitter();
  const decoder = new EventEmitter();
  decoder.destroy = () => decoder.emit("close");
  const opusStream = new EventEmitter();
  opusStream.pipe = () => decoder;
  opusStream.destroy = () => undefined;
  const messages = [];
  const logs = [];
  let enqueued = false;
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
    session: {
      enqueue: () => {
        enqueued = true;
        return true;
      },
    },
    postText: async (content) => messages.push(content),
    logger: { error: (entry) => logs.push(entry) },
    createDecoder: () => decoder,
  });

  speaking.emit("start", "44444444444444444");
  assert.doesNotThrow(() => decoder.emit("data", "not-pcm"));
  assert.doesNotThrow(() => decoder.emit("end"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(enqueued, false);
  assert.equal(logs[0].event, "receive_frame_failed");
  assert.deepEqual(messages, [
    "⚠️ 音声データを処理できませんでした。もう一度話してください。",
  ]);
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
  const client = Object.assign(new EventEmitter(), {
    isReady: () => true,
    login: async (token) => calls.push(["login", token]),
    guilds: { fetch: async (id) => (calls.push(["guild", id]), guild) },
    destroy: async () => {
      calls.push(["destroy"]);
      throw new Error("client cleanup rejection");
    },
  });
  const connection = Object.assign(new EventEmitter(), {
    receiver: { speaking: new EventEmitter() },
    destroy: () => {
      calls.push(["disconnect"]);
      throw new Error("connection cleanup failure");
    },
  });
  const config = makeVoiceConfig();
  const transportLogs = [];
  const service = await startDiscordVoiceCodex({
    config,
    client,
    logger: {
      info: () => {
        throw new Error("logger failure");
      },
      error: (entry) => transportLogs.push(entry),
    },
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
  assert.doesNotThrow(() =>
    client.emit("error", new Error("secret client detail")),
  );
  assert.doesNotThrow(() =>
    connection.emit("error", new Error("secret connection detail")),
  );
  assert.deepEqual(
    transportLogs.map(({ event, errorName }) => ({ event, errorName })),
    [
      { event: "discord_client_failed", errorName: "Error" },
      { event: "voice_connection_failed", errorName: "Error" },
    ],
  );
  assert.doesNotMatch(JSON.stringify(transportLogs), /secret/);
  await service.stop();
  await service.stop();
  assert.equal(service.session.state, "stopped");
  assert.equal(calls.filter(([kind]) => kind === "disconnect").length, 1);
  assert.equal(calls.filter(([kind]) => kind === "destroy").length, 1);
});

test("voice startup failure destroys a logged-in client and partial connection", async () => {
  const calls = [];
  const connection = {
    receiver: { speaking: new EventEmitter() },
    destroy: () => {
      calls.push("disconnect");
      throw new Error("connection cleanup failure");
    },
  };
  const client = {
    isReady: () => true,
    login: async () => calls.push("login"),
    guilds: {
      fetch: async () => ({
        id: "11111111111111111",
        voiceAdapterCreator: {},
        channels: {
          fetch: async (id) =>
            id === "22222222222222222"
              ? { id, type: ChannelType.GuildVoice }
              : { isTextBased: () => true, send: async () => undefined },
        },
      }),
    },
    destroy: async () => {
      calls.push("destroy-client");
      throw new Error("client cleanup rejection");
    },
  };

  await assert.rejects(
    () =>
      startDiscordVoiceCodex({
        config: makeVoiceConfig(),
        client,
        logger: { info: () => undefined },
        dependencies: {
          readCredential: async () => ({ token: "bot-test-token" }),
          joinVoiceChannel: () => connection,
          entersState: async () => {
            throw new Error("voice connection timeout");
          },
          audioAdapter: {},
          codexRunner: { prepare: async () => undefined },
        },
      }),
    /voice connection timeout/,
  );
  assert.deepEqual(calls, ["login", "disconnect", "destroy-client"]);
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
