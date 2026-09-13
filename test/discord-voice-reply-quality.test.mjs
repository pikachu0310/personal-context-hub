import assert from "node:assert/strict";
import test from "node:test";
import { DiscordVoiceMeetingSession } from "../src/discord-voice-session.mjs";
import {
  CodexVoiceRunner,
  createOpenAIAudioAdapter,
} from "../src/discord-voice-openai.mjs";

const until = async (check) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};
function meeting(extra = {}) {
  const posted = [],
    spoken = [];
  const session = new DiscordVoiceMeetingSession({
    transcribe: async (wav) => wav.toString(),
    observe: async () =>
      JSON.stringify({ minutes: "要点", shouldReply: false }),
    upsertLiveTranscript: async () => {},
    upsertMinutes: async () => {},
    postText: async (text) => posted.push(text),
    synthesize: async (text) => {
      spoken.push(text);
      return Buffer.alloc(0);
    },
    playAudio: async () => {},
    immediateReactions: true,
    answerUnaddressedQuestions: true,
    autonomousTasks: true,
    scheduleInterval: () => ({}),
    cancelInterval: () => {},
    logger: { info() {} },
    ...extra,
  });
  return { session, posted, spoken };
}

test("ambiguous human conversation stays recorded without a filler response", async () => {
  let calls = 0;
  const { session, posted, spoken } = meeting({
    quickReply: async () => {
      calls++;
      return { action: "ignore", reply: "" };
    },
  });
  try {
    await session.addText("それどうやんの？", { userId: "guest" });
    await until(() => calls === 1 && session.activeQuickReplies === 0);
    assert.deepEqual(posted, []);
    assert.deepEqual(spoken, []);
    assert.equal(session.recentConversation[0].text, "それどうやんの？");
  } finally {
    await session.stop();
  }
});

test("reply receives recent observed conversation, task evidence and current state without slicing away minutes", async () => {
  let input, saved;
  const result = {
    id: "result-one",
    meetingId: "meeting",
    title: "接続診断",
    result: "manual disconnect was recorded",
    currentState: "completed",
  };
  const { session } = meeting({
    initialState: {
      meetingId: "meeting",
      minutes: "最重要の決定" + "要点".repeat(6000),
    },
    checkpoint: async (state) => {
      saved = structuredClone(state);
    },
    getTasks: () => [
      { id: result.id, title: result.title, state: "completed" },
    ],
    getTaskResult: () => result,
    getRuntimeContext: () => ({ voiceStatus: "ready" }),
    quickReply: async (request) => {
      input = request;
      return { action: "reply", reply: "手動退出が記録されています。" };
    },
  });
  try {
    await session.addText("接続診断の結果を見ています。", { userId: "guest" });
    await until(() => !session.observing);
    await session.observeNow();
    assert.equal(session.statements.length, 0);
    await session.addText("その結果は？", { userId: "guest" });
    await until(() => input && session.activeQuickReplies === 0);
    assert.ok(
      input.context.conversation.some(
        (x) => x.text === "接続診断の結果を見ています。",
      ),
    );
    assert.equal(input.context.results[0].result, result.result);
    assert.equal(input.context.runtime.voiceStatus, "ready");
    assert.ok(saved.recentConversation.some((x) => x.role === "assistant"));
    await session.newMeeting();
    assert.deepEqual(session.recentConversation, []);
  } finally {
    await session.stop();
  }
});

test("question requiring evidence invokes the investigator and never speaks an acknowledgement", async () => {
  let release,
    inspecting = false;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const { session, posted, spoken } = meeting({
    quickReply: async () => ({ action: "investigate", reply: "" }),
    investigateQuestion: async ({ text }) => {
      assert.match(text, /抜ける/);
      inspecting = true;
      await wait;
      return "切断ログと実装を確認しました。手動退出後の再接続は抑止されています。";
    },
  });
  try {
    await session.addText("ボットがたまに抜ける理由は？", { userId: "guest" });
    await until(() => inspecting);
    assert.deepEqual(posted, []);
    assert.deepEqual(spoken, []);
    assert.equal(session.activeInvestigations, 1);
    release();
    await until(() => spoken.length === 1);
    assert.match(spoken[0], /切断ログと実装/);
    assert.equal(posted.length, 1);
  } finally {
    release();
    await session.stop();
  }
});

test("failed passive routing stays quiet and failed investigation is text only", async () => {
  const { session, spoken, posted } = meeting({
    quickReply: async () => {
      throw new Error("routing failed");
    },
  });
  await session.addText("それは何？", { userId: "guest" });
  await until(() => session.activeQuickReplies === 0);
  assert.deepEqual(spoken, []);
  assert.deepEqual(posted, []);
  await session.stop();
  const second = meeting({
    quickReply: async () => ({ action: "investigate" }),
    investigateQuestion: async () => {
      throw new Error("inspection failed");
    },
  });
  await second.session.addText("Botの切断原因は？", { userId: "guest" });
  await until(() => second.session.activeQuickReplies === 0);
  assert.equal(second.posted.length, 1);
  assert.deepEqual(second.spoken, []);
  await second.session.stop();
});

test("routing uses a strict decision contract and suppresses generic acknowledgement output", async () => {
  let request;
  const adapter = createOpenAIAudioAdapter(
    {},
    {
      client: {
        responses: {
          create: async (value) => {
            request = value;
            return {
              output_text: JSON.stringify({
                action: "reply",
                reply: "呼びかけを確認しました。何かお手伝いできますか？",
              }),
            };
          },
        },
      },
    },
  );
  assert.deepEqual(
    await adapter.quickReply({
      text: "それどうやんの？",
      context: { minutes: "既存の議事録", conversation: [] },
    }),
    { action: "ignore", reply: "" },
  );
  assert.equal(request.text.format.strict, true);
  assert.equal(JSON.parse(request.input).context.minutes, "既存の議事録");
  assert.equal(request.store, false);
});

test("evidence investigation uses its own read-only Codex session without resetting meeting history", async () => {
  let options, prompt;
  const runner = new CodexVoiceRunner(
    {
      workingDirectory: "/workspace",
      meetingStatePath: "/state/current.meeting.json",
      observerModel: "test-model",
      observerReasoningEffort: "high",
    },
    {
      codex: {
        startThread: (value) => {
          options = value;
          return {
            run: async (text) => {
              prompt = text;
              return { finalResponse: "ソースを確認した結果です。" };
            },
          };
        },
      },
    },
  );
  const observer = { id: "existing-observer" };
  runner.thread = observer;
  assert.equal(
    await runner.investigateQuestion({
      text: "切断処理を確認して",
      context: { runtime: { voiceStatus: "ready" } },
    }),
    "ソースを確認した結果です。",
  );
  assert.equal(options.sandboxMode, "read-only");
  assert.equal(options.approvalPolicy, "never");
  assert.equal(runner.thread, observer);
  assert.match(prompt, /実際に読んで/);
  assert.match(prompt, /current.meeting.json/);
});
