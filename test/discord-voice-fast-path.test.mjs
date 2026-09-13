import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  qualifyTranscriptionAudio,
  wrapPcmAsWav,
} from "../src/discord-voice-audio.mjs";
import { DiscordVoiceMeetingSession } from "../src/discord-voice-session.mjs";
import {
  createIdobataMessageHandler,
  createIdobataSlashHandler,
} from "../src/discord-voice-commands.mjs";
import {
  createMinutesDiscordPost,
  startDiscordVoiceCodex,
} from "../src/discord-voice-server.mjs";
import { buildMeetingObservationPrompt } from "../src/discord-voice-openai.mjs";

async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
}

test("signal gate rejects silence/DC/clicks but retains short quiet signals", () => {
  const pcm = Buffer.alloc(192_000);
  assert.equal(qualifyTranscriptionAudio(wrapPcmAsWav(pcm)).accepted, false);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  assert.equal(qualifyTranscriptionAudio(wrapPcmAsWav(pcm)).accepted, false);
  pcm.fill(0);
  for (let i = 0; i < 1920; i += 2) pcm.writeInt16LE(i % 4 ? 20000 : -20000, i);
  assert.equal(qualifyTranscriptionAudio(wrapPcmAsWav(pcm)).accepted, false);
  pcm.fill(0);
  for (let i = 0; i < 38_400; i += 2)
    pcm.writeInt16LE(Math.round(200 * Math.sin(i / 15)), i);
  assert.equal(qualifyTranscriptionAudio(wrapPcmAsWav(pcm)).accepted, true);
});

test("unaddressed question answers and speaks while minutes observer remains blocked", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const posts = [],
    spoken = [],
    questions = [];
  const session = new DiscordVoiceMeetingSession({
    transcribe: async (wav) => wav.toString(),
    observe: async () => {
      await blocked;
      return JSON.stringify({ minutes: "要点", shouldReply: false });
    },
    quickReply: async (question) => {
      questions.push(question);
      return "二つあります。";
    },
    upsertLiveTranscript: async () => {},
    upsertMinutes: async () => {},
    postText: async (text) => posts.push(text),
    synthesize: async (text) => {
      spoken.push(text);
      return Buffer.alloc(0);
    },
    playAudio: async () => {},
    immediateReactions: true,
    answerUnaddressedQuestions: true,
    ownerUserId: "owner",
    allParticipantsOperate: true,
    autonomousTasks: true,
    scheduleInterval: () => ({}),
    cancelInterval: () => {},
    logger: { info() {} },
  });
  try {
    await session.addText("今日は晴れです", { userId: "guest" });
    await until(() => session.observing);
    await session.addText("選択肢は何がありますか？", { userId: "guest" });
    await until(() => spoken.length === 1);
    assert.equal(session.observing, true);
    assert.equal(questions.length, 1);
    assert.equal(posts.length, 1);
    assert.equal(
      session.statements.find((x) => x.text.includes("選択肢")).taskEligible,
      true,
    );
    await session.addText("はい。", { userId: "guest" });
    assert.equal(questions.length, 1);
  } finally {
    release();
    await session.stop();
  }
});

test("all participants can use slash join/leave only in the configured guild/channel", async () => {
  const config = {
    guildId: "guild",
    textChannelId: "text",
    allowedUserId: "owner",
    allParticipantsOperate: true,
  };
  const calls = [],
    replies = [];
  const handleMessage = createIdobataMessageHandler({
    config,
    session: {},
    reconnectVoice: async () => {
      calls.push("join");
      return "connected";
    },
    leaveVoice: async () => calls.push("leave"),
  });
  const slash = createIdobataSlashHandler({ config, handleMessage });
  const interaction = (command) => ({
    id: command,
    guildId: "guild",
    channelId: "text",
    user: { id: "guest" },
    commandName: "ido",
    isChatInputCommand: () => true,
    options: { getSubcommand: () => command, getString: () => null },
    deferReply: async () => {},
    editReply: async (p) => replies.push(p),
    followUp: async (p) => replies.push(p),
    reply: async (p) => replies.push(p),
  });
  await slash(interaction("leave"));
  await slash(interaction("join"));
  assert.deepEqual(calls, ["leave", "join"]);
  assert.equal(
    await slash({ ...interaction("leave"), guildId: "other" }),
    false,
  );
  await slash({ ...interaction("leave"), channelId: "other" });
  assert.equal(calls.length, 2);
  config.allParticipantsOperate = false;
  await slash({ ...interaction("leave"), id: "denied" });
  assert.equal(calls.length, 2);
});

test("minutes has complete UTF-8 attachment, editable summary, and a pinned entry", async () => {
  const sends = [],
    edits = [];
  let pins = 0;
  const message = {
    edit: async (payload) => {
      edits.push(payload);
      return message;
    },
    pin: async () => {
      pins++;
    },
  };
  const update = createMinutesDiscordPost({
    send: async (payload) => {
      sends.push(payload);
      return message;
    },
  });
  const minutes = "議事録の詳細".repeat(1000);
  await update("短い要点", { minutes });
  await update("新しい要点", { minutes: minutes + "訂正" });
  assert.equal(sends.length, 1);
  assert.equal(pins, 1);
  assert.equal(edits[0].files[0].attachment.toString(), minutes + "訂正");
});

test("autonomous task observation authorizes guest context and creates a concrete task", async () => {
  const tasks = [];
  const session = new DiscordVoiceMeetingSession({
    transcribe: async (wav) => wav.toString(),
    observe: async ({ statements }) =>
      JSON.stringify({
        minutes: "入力検証が不足",
        tasks: [
          {
            title: "入力検証を追加する",
            kind: "implementation",
            sourceSequences: [statements[0].sequence],
          },
        ],
      }),
    upsertLiveTranscript: async () => {},
    upsertMinutes: async () => {},
    postText: async () => {},
    synthesize: async () => Buffer.alloc(0),
    playAudio: async () => {},
    enqueueTask: async (task) => {
      tasks.push(task);
      return true;
    },
    tasksEnabled: true,
    ownerUserId: "owner",
    allParticipantsOperate: true,
    autonomousTasks: true,
    scheduleInterval: () => ({}),
    cancelInterval: () => {},
    logger: { info() {} },
  });
  await session.addText("入力欄の検証が足りない気がする", { userId: "guest" });
  await session.observeNow();
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].request, /自律実行/);
  const prompt = buildMeetingObservationPrompt({
    ownerUserId: "owner",
    allParticipantsOperate: true,
    autonomousTasks: true,
    powerMode: true,
    statements: [{ userId: "guest", text: "入力が不便", sequence: 1 }],
  });
  assert.match(prompt, /"isOwner":true/);
  assert.match(prompt, /明確な依頼がなくても/);
  await session.stop();
});

test("minutes restart restores only the Bot's previous entry", async () => {
  let edits = 0;
  const own = {
    author: { id: "bot" },
    content: "📝 **議事録・共有コンテキスト**",
    pinned: true,
    edit: async (payload) => {
      edits++;
      assert.equal(payload.files[0].attachment.toString(), "全文");
      return own;
    },
  };
  const update = createMinutesDiscordPost(
    {
      messages: {
        fetch: async () => [
          { author: { id: "someone" }, content: own.content },
          own,
        ],
      },
      send: async () => assert.fail("must restore existing entry"),
    },
    { botUserId: "bot" },
  );
  await update("要点", { minutes: "全文" });
  assert.equal(edits, 1);
});

test("manual voice leave does not auto-rejoin and slash join resumes connection", async () => {
  const commands = [];
  const players = [];
  let rejoins = 0;
  const connection = Object.assign(new EventEmitter(), {
    state: { status: "ready" },
    receiver: { speaking: new EventEmitter() },
    subscribe: (player) => players.push(player),
    disconnect() {
      this.state.status = "disconnected";
      this.emit("disconnected");
    },
    rejoin() {
      rejoins++;
      this.state.status = "ready";
      return true;
    },
    destroy() {},
  });
  const client = Object.assign(new EventEmitter(), {
    isReady: () => true,
    login: async () => {},
    destroy() {},
    guilds: {
      fetch: async () => ({
        id: "guild",
        voiceAdapterCreator: {},
        commands: { create: async (cmd) => commands.push(cmd) },
        channels: {
          fetch: async (id) =>
            id === "voice"
              ? { id, type: 2 }
              : {
                  isTextBased: () => true,
                  send: async () => ({
                    edit: async () => {},
                    pin: async () => {},
                  }),
                },
        },
      }),
    },
  });
  const service = await startDiscordVoiceCodex({
    config: {
      guildId: "guild",
      voiceChannelId: "voice",
      textChannelId: "text",
      allowedUserId: "owner",
      allParticipantsOperate: true,
      voiceMode: "turn",
      stageTimeouts: {},
    },
    client,
    logger: { info() {}, error() {} },
    dependencies: {
      readCredential: async () => ({ token: "test" }),
      codexRunner: { prepare: async () => {} },
      audioAdapter: {},
      joinVoiceChannel: () => connection,
      entersState: async () => connection,
    },
  });
  const sendCommand = async (command) => {
    let done = false;
    client.emit("interactionCreate", {
      id: command,
      guildId: "guild",
      channelId: "text",
      user: { id: "guest" },
      commandName: "ido",
      isChatInputCommand: () => true,
      options: { getSubcommand: () => command, getString: () => null },
      deferReply: async () => {},
      editReply: async () => {
        done = true;
      },
      followUp: async () => {},
    });
    await until(() => done);
  };
  try {
    assert.equal(commands[0].name, "ido");
    const startListeners = connection.receiver.speaking.listenerCount("start");
    const endListeners = connection.receiver.speaking.listenerCount("end");
    assert.equal(players.length, 1);
    await sendCommand("leave");
    assert.equal(players.length, 2);
    assert.equal(
      connection.receiver.speaking.listenerCount("start"),
      startListeners,
    );
    assert.equal(
      connection.receiver.speaking.listenerCount("end"),
      endListeners,
    );
    assert.equal(rejoins, 0);
    assert.equal(connection.state.status, "disconnected");
    await sendCommand("join");
    await until(() => rejoins === 1);
    assert.equal(connection.state.status, "ready");
  } finally {
    await service.stop();
  }
});
