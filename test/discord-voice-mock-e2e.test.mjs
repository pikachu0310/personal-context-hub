import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ChannelType, MessageFlags } from "discord.js";
import {
  createEditableDiscordPost,
  formatDiscordTaskAction,
  formatDiscordTaskCard,
  startDiscordVoiceCodex,
} from "../src/discord-voice-server.mjs";

test("live post updates retain the original message on a transient failure and replace only a deleted message", async () => {
  const sent = [];
  const edited = [];
  let editError;
  const message = {
    async edit(payload) {
      if (editError) throw editError;
      edited.push(payload.content);
      return this;
    },
  };
  const update = createEditableDiscordPost({
    async send(payload) {
      sent.push(payload.content);
      return message;
    },
  });
  await update("initial conversation");
  editError = Object.assign(new Error("temporary outage"), { status: 503 });
  await assert.rejects(update("processing"), /temporary outage/);
  assert.deepEqual(sent, ["initial conversation"]);
  editError = undefined;
  await update("response complete");
  assert.deepEqual(edited, ["response complete"]);
  editError = Object.assign(new Error("Unknown Message"), { code: 10008 });
  await update("new conversation");
  assert.deepEqual(sent, ["initial conversation", "new conversation"]);
});

const config = Object.freeze({
  guildId: "11111111111111111",
  voiceChannelId: "22222222222222222",
  textChannelId: "33333333333333333",
  allowedUserId: "44444444444444444",
  listenToEveryone: true,
  powerMode: true,
  voiceMode: "meeting",
  silentMessages: true,
  workingDirectory: "/tmp/mock-workspace",
  statePath: "/tmp/mock-state.json",
  sttModel: "gpt-transcribe",
  ttsModel: "gpt-4o-mini-tts",
  ttsVoice: "marin",
  ttsSpeed: 2,
  codexModel: undefined,
  codexHome: undefined,
  isolatedCodexHome: "/tmp/mock-codex-home",
  codexSandbox: "danger-full-access",
  silenceMs: 1_000,
  minimumAudioMs: 250,
  maximumAudioSeconds: 90,
  maximumQueuedTurns: 3,
  maximumPendingTranscriptions: 60,
  maximumPendingTasks: 10,
  taskConcurrency: 2,
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

test("Discord task cards expose a stable log link and readable state", () => {
  const content = formatDiscordTaskCard(
    { id: "task-123", title: "README *更新*" },
    { state: "completed", threadId: "55555555555555555", elapsedMs: 65_000 },
  );
  assert.match(content, /状態: \*\*完了\*\* · 1分5秒/);
  assert.match(content, /ログ: <#55555555555555555>/);
  assert.match(content, /README \\\*更新\\\*/);

  const waiting = formatDiscordTaskCard(
    { id: "task-123", title: "README更新" },
    { state: "running", threadId: "55555555555555555", pendingInstructions: 2 },
  );
  assert.match(waiting, /追加指示 \*\*2件待機\*\*/);
});

test("Discord task actions explain whether work is queued, resumed, or stopped", () => {
  assert.equal(
    formatDiscordTaskAction({
      type: "instruction",
      disposition: "queued",
      pendingInstructions: 2,
    }),
    "➕ 追加指示を受け付けました。現在の処理後に続けます（待機 2件）。",
  );
  assert.equal(
    formatDiscordTaskAction({
      type: "instruction",
      disposition: "resumed",
      pendingInstructions: 1,
    }),
    "▶️ 追加指示を受け付けました。同じCodexセッションで再開します。",
  );
  assert.equal(
    formatDiscordTaskAction({ type: "cancelled", discardedInstructions: 1 }),
    "⏹️ タスクを停止し、未処理の追加指示1件も破棄しました。",
  );
});

test("synthetic participant PCM crosses receive, STT, Codex, Text, TTS, and playback", async () => {
  const turnEvents = [];
  const posts = [];
  const taskThreadPosts = [];
  const archivedStatements = [];
  const speaking = new EventEmitter();
  const opusStream = new EventEmitter();
  const decoder = new EventEmitter();
  const connection = new EventEmitter();
  let connectionDestroyCalls = 0;
  let clientDestroyCalls = 0;
  let transcriptArchiveStopCalls = 0;
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
    members: new Map([[config.allowedUserId, { displayName: "Owner" }]]),
  };
  const textChannel = {
    isTextBased: () => true,
    send: async (payload) => {
      assert.equal(payload.flags, MessageFlags.SuppressNotifications);
      posts.push(payload);
      if (payload.content === "タスクを追加しました：モック作業") {
        turnEvents.push("post_response");
      }
      const message = {
        id: `message-${posts.length}`,
        edit: async (edited) => {
          assert.equal(edited.flags, undefined);
          posts.push(edited);
          return message;
        },
        startThread: async ({ name, autoArchiveDuration }) => {
          assert.match(name, /モック作業/);
          assert.equal(autoArchiveDuration, 1_440);
          return {
            id: "55555555555555555",
            send: async (threadPayload) => {
              assert.equal(
                threadPayload.flags,
                MessageFlags.SuppressNotifications,
              );
              taskThreadPosts.push(threadPayload);
              return { id: `thread-message-${taskThreadPosts.length}` };
            },
          };
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
          assert.equal(text, "タスクを追加しました：モック作業");
          return synthesized;
        },
      },
      codexRunner: {
        prepare: async () => undefined,
        observeMeeting: async ({ transcript }) => {
          turnEvents.push("codex");
          assert.equal(transcript, "[Owner] モック発話");
          return JSON.stringify({
            minutes: "- Ownerがモック発話",
            shouldReply: true,
            reply: "モック応答",
            tasks: [{ title: "モック作業", sourceSequences: [1] }],
          });
        },
        runTask: async (task, { onProgress }) => {
          turnEvents.push("power_task");
          assert.equal(task.request, "モック発話");
          await onProgress("🔎 モック進捗");
          return "モックタスク完了";
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
      transcriptArchive: {
        append: async (statement) => archivedStatements.push({ ...statement }),
        stop: async () => {
          transcriptArchiveStopCalls += 1;
        },
      },
      scheduleInterval: () => ({ unref: () => undefined }),
      cancelInterval: () => undefined,
    },
  });

  speaking.emit("start", config.allowedUserId);
  decoder.emit("data", Buffer.alloc(48_000));
  decoder.emit("end");
  await eventually(() => service.session.statements.length === 1);
  assert.equal(await service.session.observeNow(), true);
  await eventually(() =>
    taskThreadPosts.some(({ content }) => content === "モックタスク完了"),
  );

  assert.deepEqual(decoderOptions, {
    rate: 48_000,
    channels: 2,
    frameSize: 960,
  });
  assert.equal(turnEvents[0], "stt");
  for (const stage of [
    "codex",
    "post_response",
    "tts",
    "playback",
    "power_task",
  ]) {
    assert.ok(turnEvents.includes(stage));
  }
  assert.ok(posts.some(({ content }) => /会議観測モード/.test(content)));
  assert.ok(posts.some(({ content }) => /Owner.*モック発話/.test(content)));
  assert.ok(posts.some(({ content }) => /議事録/.test(content)));
  assert.deepEqual(
    archivedStatements.map(({ speakerName, text }) => ({ speakerName, text })),
    [{ speakerName: "Owner", text: "モック発話" }],
  );
  assert.ok(
    posts.some(({ content }) => content === "タスクを追加しました：モック作業"),
  );
  assert.ok(posts.some(({ content }) => /Codexタスク/.test(content)));
  assert.ok(
    posts.some(({ content }) => /ログ: <#55555555555555555>/.test(content)),
  );
  assert.ok(posts.some(({ content }) => /状態: \*\*完了\*\*/.test(content)));
  assert.ok(taskThreadPosts.some(({ content }) => /依頼内容/.test(content)));
  assert.ok(
    taskThreadPosts.some(({ content }) =>
      /このスレッドで操作できます/.test(content),
    ),
  );
  assert.ok(taskThreadPosts.some(({ content }) => /モック進捗/.test(content)));
  assert.ok(
    taskThreadPosts.some(({ content }) => /Codexタスク開始/.test(content)),
  );
  assert.ok(
    taskThreadPosts.some(({ content }) => /Codexタスク完了/.test(content)),
  );
  assert.ok(
    taskThreadPosts.some(({ content }) => content === "モックタスク完了"),
  );
  assert.ok(
    posts.every(({ content }) => !/Codexタスク(開始|完了)/.test(content)),
  );
  assert.ok(
    [...posts, ...taskThreadPosts].every(
      ({ allowedMentions }) =>
        Array.isArray(allowedMentions?.parse) &&
        allowedMentions.parse.length === 0,
    ),
  );

  await service.stop();
  await service.stop();
  assert.equal(connectionDestroyCalls, 1);
  assert.equal(clientDestroyCalls, 1);
  assert.equal(transcriptArchiveStopCalls, 1);

  console.log(
    JSON.stringify({
      marker: "VOICE_CODEX_MOCK_E2E_OK",
      externalCalls: 0,
      stages: turnEvents,
    }),
  );
});
