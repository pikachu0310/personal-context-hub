import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBotInvocation,
  invocationAcknowledgement,
} from "../src/engine/observation/invocation.mjs";
import {
  isBotAddressed,
  hasTaskCommitment,
} from "../src/engine/observation/participation.mjs";
import {
  parseImmediateTaskStop,
  isImmediateTaskStatus,
  isImmediateSpeechStop,
  parseImmediateTaskInstruction,
} from "../src/engine/observation/intents.mjs";
import { createOpenAIAudioAdapter } from "../src/providers/openai-audio.mjs";
import { DiscordVoiceMeetingSession } from "../src/adapters/discord/sessions.mjs";

// Synthetic examples cover observed ASR patterns without storing private speech.
test("vocatives tolerate fillers, greetings, repetition and bounded ASR aliases", () => {
  for (const text of [
    "井戸Bot",
    "井戸Bot。",
    "あ、イドボット、返事して。",
    "あー、こんにちは、イドボット。進捗は？",
    "えっと、ねえ、移動ボット、答えて。",
    "コーデックスボット、移動ボット、返事して。",
    "では次です。あ、イドポット、聞こえますか？",
    "もしもし、いどぼっと、聞こえてる？",
    "Codex Bot, hello?",
    "井戸Ｂｏｔ：進捗は？",
    "井戸Bot教えて",
    "えーと、井戸Bot、結果は？",
    "あ、リドボット、何かしゃべって。",
  ])
    assert.equal(isBotAddressed(text), true, text);
  assert.equal(
    parseBotInvocation("挨拶です。あ、移動ボット、井戸Bot、資料を確認して。")
      .body,
    "資料を確認して。",
  );
  assert.equal(
    parseBotInvocation("あ、井戸Bot、「空文字」を説明して。").body,
    "「空文字」を説明して。",
  );
});

test("mentions, quotations, different addressees and unrelated words remain quiet", () => {
  for (const text of [
    "井戸Botの名前を変更したい",
    "移動ボットっていう名前なの？",
    "あ、イドボットっていう単語が認識されない",
    "井戸Bot、っていう名前だよ",
    "今、移動ボットをどう観測するか考えている",
    "山田さん、返事して。",
    "『あ、井戸Bot。返事して』と発言した",
    "「説明。井戸Bot、止めて。」と書いてある",
    "コーデックスの料金は？",
    "リロボット、話して",
    "井戸元の説明をして",
    "それどうやるの？",
    "井戸Botanyについて",
    "井戸Bot、という呼び方にした",
    "井戸Bot、の応答が遅い",
    "「あ。井戸Bot、止めて",
    "あ、井戸Bot、返事してって言っても聞いてないね",
    "リドボットって認識されたね",
  ])
    assert.equal(isBotAddressed(text), false, text);
});

test("quick replies and all control paths share the same invocation body", () => {
  const prefix = "えっと、移動ボット、イドボット、";
  assert.deepEqual(
    parseImmediateTaskStop(prefix + "タスク abcd1234 を止めて。"),
    { taskId: "abcd1234" },
  );
  assert.equal(isImmediateTaskStatus(prefix + "進捗は？"), true);
  assert.equal(isImmediateSpeechStop(prefix + "読み上げを止めて。"), true);
  assert.deepEqual(
    parseImmediateTaskInstruction(prefix + "今の版を少し戻して。", {
      requireWakeWord: true,
    }),
    {},
  );
  assert.equal(parseImmediateTaskStop(prefix + "止めていいかな？"), undefined);
  assert.equal(
    parseImmediateTaskStop("「移動ボット、止めて」と言った"),
    undefined,
  );
  const task = {
    executionIntent: "requested",
    sourceSequences: [1],
    authorizationSequences: [1],
  };
  const source = (text) => [
    { text, sequence: 1, userId: "test-user", taskEligible: true },
  ];
  assert.equal(
    hasTaskCommitment(task, source(prefix + "入力検証を追加して。")),
    true,
  );
  for (const body of [
    "テストを追加してもいいかも",
    "石を建てて",
    "まだ実行しなくていい",
    "返事して",
  ])
    assert.equal(hasTaskCommitment(task, source(prefix + body)), false, body);
  // A short acknowledgement is not itself a task proposal; task authorization stays separate.
  assert.equal(
    invocationAcknowledgement(prefix + "入力検証を追加して。"),
    undefined,
  );
});

test("explicit wake and connection checks respond briefly without a model round trip", async () => {
  const adapter = createOpenAIAudioAdapter(
    {},
    {
      client: {
        responses: {
          create() {
            assert.fail("short calls need no model");
          },
        },
      },
    },
  );
  for (const text of [
    "あ、イドボット。",
    "移動ボット、何かしゃべって。",
    "コーデックスボット、聞こえていますか？",
  ]) {
    const result = await adapter.quickReply({ text, explicitlyAsked: true });
    assert.equal(result.action, "reply");
    assert.match(result.reply, /^はい、/u);
    assert.deepEqual(await adapter.quickReply({ text }), {
      action: "ignore",
      reply: "",
    });
  }
});

test("a recognized wake reaches text and speech despite semantic pass; ordinary conversation stays silent", async () => {
  const posted = [],
    spoken = [],
    hud = [],
    logs = [];
  const adapter = createOpenAIAudioAdapter({}, { client: {} });
  let classifications = 0,
    tasks = 0;
  const session = new DiscordVoiceMeetingSession({
    transcribe: async (wav) => wav.toString(),
    quickReply: adapter.quickReply,
    classifyVoiceNeed: async () => {
      classifications++;
      return { decision: "pass" };
    },
    observe: async () =>
      JSON.stringify({ minutes: "", shouldReply: false, tasks: [] }),
    enqueueTask: async () => {
      tasks++;
    },
    upsertLiveTranscript: async (text) => hud.push(text),
    upsertMinutes: async () => {},
    postText: async (text) => posted.push(text),
    synthesize: async (text) => {
      spoken.push(text);
      return Buffer.alloc(2);
    },
    playAudio: async () => {},
    immediateReactions: true,
    autonomousTasks: true,
    scheduleInterval: () => ({}),
    cancelInterval: () => {},
    logger: { info: (value) => logs.push(value) },
  });
  try {
    await session.addText("あ、移動ボット、何かしゃべって。", {
      userId: "test-user",
    });
    for (let i = 0; i < 200 && !spoken.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(classifications, 0);
    assert.equal(posted.length, 1);
    assert.equal(spoken[0], "はい、聞いています。");
    await session.addText("移動ボットっていう名前を変えたいね。", {
      userId: "test-user",
    });
    await session.observeNow();
    assert.equal(posted.length, 1);
    assert.equal(tasks, 0);
    assert.ok(hud.some((text) => text.includes("回答を作成・送信待ち")));
    assert.ok(hud.some((text) => text.includes("呼びかけなし・通常の会話")));
    assert.ok(
      logs.some((entry) => entry.event === "meeting_invocation_decision"),
    );
  } finally {
    await session.stop();
  }
});
