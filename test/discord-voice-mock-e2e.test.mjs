import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { ChannelType, MessageFlags } from "discord.js";
import { VoiceConnectionStatus } from "@discordjs/voice";
import {
  createEditableDiscordPost,
  createDiscordTaskCardUpdater,
  createDiscordTaskThread,
  formatDiscordTaskAction,
  formatDiscordTaskCard,
} from "../src/adapters/discord/transport.mjs";
import { startDiscordVoiceCodex } from "../src/runtime/discord-voice/index.mjs";

test("task creation recovers lost card, thread, and request acknowledgements in the same Discord thread", async () => {
  const acceptedCards = new Map();
  const acceptedMessages = new Map();
  let threadCreated = false;
  let threadCreations = 0;
  let lookupOffline = true;
  const task = { id: "task01", createdAt: 1, title: "work", request: "fix it" };
  const thread = {
    id: "starter01",
    parentId: "parent01",
    isThread: () => true,
    send: async (payload) => {
      assert.equal(payload.enforceNonce, true);
      if (acceptedMessages.has(payload.nonce))
        return acceptedMessages.get(payload.nonce);
      const message = { content: payload.content };
      acceptedMessages.set(payload.nonce, message);
      if (payload.content.includes("依頼内容"))
        throw new Error("request acknowledgement lost");
      return message;
    },
  };
  const starter = {
    id: thread.id,
    edit: async () => starter,
    startThread: async () => {
      if (threadCreated) throw new Error("thread already exists");
      threadCreated = true;
      threadCreations += 1;
      throw new Error("thread acknowledgement lost");
    },
  };
  const channel = {
    id: thread.parentId,
    client: {
      channels: {
        fetch: async (id, options) => {
          assert.equal(id, starter.id);
          assert.equal(options.force, true);
          if (lookupOffline) throw new Error("lookup offline");
          return thread;
        },
      },
    },
    send: async (payload) => {
      assert.equal(payload.enforceNonce, true);
      if (acceptedCards.has(payload.nonce))
        return acceptedCards.get(payload.nonce);
      acceptedCards.set(payload.nonce, starter);
      throw new Error("card acknowledgement lost");
    },
  };
  // Recreate the factory and task object to model restarting the adapter.
  const attempt = () => createDiscordTaskThread(channel)({ ...task });
  await assert.rejects(attempt(), /card acknowledgement lost/);
  await assert.rejects(attempt(), /thread acknowledgement lost/);
  lookupOffline = false;
  await assert.rejects(attempt(), /request acknowledgement lost/);
  const surface = await attempt();
  assert.equal(surface.threadId, thread.id);
  assert.equal(surface.starterId, starter.id);
  assert.equal(acceptedCards.size, 1);
  assert.equal(threadCreations, 1);
  assert.equal(acceptedMessages.size, 2);
  assert.equal(
    [...acceptedMessages.values()].filter((message) =>
      message.content.includes("依頼内容"),
    ).length,
    1,
  );
});

test("task cards retry transient edits and serialize replacement of a deleted card", async () => {
  const posts = [],
    edits = [];
  let failure;
  const replacement = {
    id: "replacement",
    edit: async (payload) => {
      edits.push(payload);
      return replacement;
    },
  };
  const original = {
    id: "original",
    edit: async () => {
      if (failure) throw failure;
      return original;
    },
  };
  const task = {
    id: "task01",
    title: "work",
    createdAt: 1,
    checkpoint: async () => {},
  };
  const channel = {
    send: async (payload) => {
      posts.push(payload);
      return replacement;
    },
  };
  const card = createDiscordTaskCardUpdater(
    channel,
    task,
    "saved-thread",
    original,
  );
  failure = Object.assign(new Error("unavailable"), { status: 503 });
  await assert.rejects(card.update({ state: "running" }), /unavailable/);
  assert.equal(posts.length, 0);
  assert.equal(card.starterId, "original");
  failure = Object.assign(new Error("deleted"), { code: 10008 });
  await Promise.all([
    card.update({ state: "running" }),
    card.update({ state: "completed" }),
  ]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].enforceNonce, true);
  assert.match(posts[0].content, /saved-thread/);
  assert.match(edits.at(-1).content, /状態: \*\*完了\*\*/);
  assert.equal(card.starterId, "replacement");
});

test("a queued card update rechecks whether its cancellation is still current before editing Discord", async () => {
  const edits = [];
  let releaseFirst;
  const firstEdit = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const starter = {
    id: "card",
    edit: async (payload) => {
      edits.push(payload.content);
      if (edits.length === 1) await firstEdit;
      return starter;
    },
  };
  const card = createDiscordTaskCardUpdater(
    {},
    { id: "task01", title: "work" },
    "thread",
    starter,
  );
  const running = card.update({ state: "running" });
  let cancelled = true;
  const old = card.update({ state: "cancelled", isCurrent: () => cancelled });
  cancelled = false;
  const completed = card.update({ state: "completed" });
  releaseFirst();
  await Promise.all([running, old, completed]);
  assert.equal(edits.length, 2);
  assert.ok(edits.every((content) => !content.includes("状態: **中止**")));
  assert.match(edits.at(-1), /状態: \*\*完了\*\*/);
  let stillCurrent = true;
  const disappearing = createDiscordTaskCardUpdater(
    {
      send: async () =>
        assert.fail("stale cancellation must not recreate a card"),
    },
    { id: "task01" },
    "thread",
    {
      id: "deleted-card",
      edit: async () => {
        stillCurrent = false;
        throw Object.assign(new Error("deleted"), { code: 10008 });
      },
    },
  );
  await disappearing.update({
    state: "cancelled",
    isCurrent: () => stillCurrent,
  });
});

test("a missing restored card keeps the task thread and reuses its replacement identity after a lost acknowledgement", async () => {
  const task = {
    id: "task01",
    createdAt: 1,
    starterId: "deleted-card",
    title: "work",
  };
  const accepted = new Map();
  const attempts = [];
  const channel = {
    send: async (payload) => {
      attempts.push(payload.nonce);
      if (accepted.has(payload.nonce)) return accepted.get(payload.nonce);
      accepted.set(payload.nonce, {
        id: "restored-card",
        edit: async () => {},
      });
      throw new Error("acknowledgement lost");
    },
  };
  const first = createDiscordTaskCardUpdater(
    channel,
    task,
    "saved-thread",
    undefined,
  );
  await assert.rejects(
    first.update({ state: "completed" }),
    /acknowledgement lost/,
  );
  const retry = createDiscordTaskCardUpdater(
    channel,
    task,
    "saved-thread",
    undefined,
  );
  await retry.update({ state: "completed" });
  assert.equal(accepted.size, 1);
  assert.equal(attempts[0], attempts[1]);
  assert.equal(retry.starterId, "restored-card");
});

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

test("text status reports voice reconnection failure and later recovery without invoking Codex", async (t) => {
  const posts = [];
  const channel = {
    isTextBased: () => true,
    send: async ({ content }) => {
      posts.push(content);
      return { edit: async () => {} };
    },
  };
  const client = new EventEmitter();
  client.login = async () => {};
  client.isReady = () => true;
  client.destroy = async () => {};
  client.guilds = {
    fetch: async () => ({
      id: config.guildId,
      voiceAdapterCreator: {},
      channels: {
        fetch: async (id) =>
          id === config.voiceChannelId
            ? { id, type: ChannelType.GuildVoice }
            : channel,
      },
    }),
  };
  const connection = new EventEmitter();
  connection.state = { status: VoiceConnectionStatus.Ready };
  connection.receiver = { speaking: new EventEmitter() };
  connection.destroy = async () => {};
  let rejoinCalls = 0;
  let disconnected = false;
  connection.rejoin = () => {
    rejoinCalls += 1;
    connection.state = {
      status: disconnected
        ? VoiceConnectionStatus.Connecting
        : VoiceConnectionStatus.Ready,
    };
    return true;
  };
  let releaseRecovery;
  const recovery = new Promise((resolve) => {
    releaseRecovery = resolve;
  });
  const service = await startDiscordVoiceCodex({
    config: { ...config, powerMode: false },
    client,
    logger: {},
    dependencies: {
      audioAdapter: {},
      codexRunner: {
        observeMeeting: async () => assert.fail("status must not invoke Codex"),
      },
      readCredential: async () => ({ token: "mock-only" }),
      joinVoiceChannel: () => connection,
      entersState: async (resource) => {
        if (!disconnected) return resource;
        await recovery;
        throw new Error("voice transport timeout");
      },
      playAudio: async () => assert.fail("text status must not play audio"),
      transcriptArchive: { append: async () => {}, stop: async () => {} },
      scheduleInterval: () => 0,
      cancelInterval: () => {},
    },
  });
  t.after(() => {
    releaseRecovery();
    return service.stop();
  });
  let sequence = 0;
  const sendCommand = (content, userId = config.allowedUserId) =>
    client.emit("messageCreate", {
      id: `command-${++sequence}`,
      author: { id: userId },
      guildId: config.guildId,
      channelId: config.textChannelId,
      channel,
      content,
    });
  const readStatus = async () => {
    const before = posts.length;
    sendCommand("!ido status");
    await eventually(() =>
      posts.slice(before).some((text) => text.startsWith("通話:")),
    );
    return posts.slice(before).find((text) => text.startsWith("通話:"));
  };
  assert.match(await readStatus(), /通話: 接続済み/);
  disconnected = true;
  connection.state = { status: VoiceConnectionStatus.Disconnected };
  connection.emit(VoiceConnectionStatus.Disconnected);
  assert.match(await readStatus(), /通話: 再接続中/);
  sendCommand("!ido reconnect", "visitor");
  await eventually(() => posts.some((text) => /操作担当者に依頼/.test(text)));
  sendCommand("!ido reconnect");
  await eventually(() => posts.some((text) => /再接続は進行中/.test(text)));
  assert.equal(rejoinCalls, 0);
  releaseRecovery();
  await eventually(() =>
    posts.some((text) => /再接続できませんでした/.test(text)),
  );
  assert.equal(connection.state.status, VoiceConnectionStatus.Connecting);
  assert.match(await readStatus(), /通話: 切断.*音声は受信していません/);
  assert.equal(rejoinCalls, 1);
  disconnected = false;
  sendCommand("!ido reconnect");
  await eventually(() => posts.some((text) => text === "通話に接続しました。"));
  assert.equal(rejoinCalls, 2);
  assert.match(await readStatus(), /通話: 接続済み/);
  sendCommand("!ido reconnect");
  await eventually(
    () => posts.filter((text) => text === "通話に接続しました。").length === 2,
  );
  assert.equal(rejoinCalls, 2);
});

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
  assert.equal(
    taskThreadPosts.find(({ content }) => content === "モックタスク完了")
      .enforceNonce,
    true,
  );
  await eventually(() =>
    posts.some(({ content }) => content.startsWith("📦 **モック作業**")),
  );
  assert.equal(
    posts.find(({ content }) => content.startsWith("📦 **モック作業**"))
      .enforceNonce,
    true,
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

  await service.session.dependencies.postText("delivery identity check", {
    idempotencyKey: "synthetic-reply:chunk:0",
  });
  assert.equal(posts.at(-1).enforceNonce, true);
  assert.match(posts.at(-1).nonce, /^[a-f0-9]{24}$/);
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
