import assert from "node:assert/strict";
import test from "node:test";
import { MeetingMemory } from "../src/discord-voice-memory.mjs";
import { parseImmediateTaskInstruction } from "../src/discord-voice-intents.mjs";

test("source retrieval preserves an older relevant statement and corrections replace sourced interpretations", () => {
  const memory = new MeetingMemory();
  const source = {
    sequence: 1,
    meetingId: "meeting",
    userId: "person",
    speakerName: "A",
    text: "決済ボタンは青色にする案です",
  };
  memory.remember(source);
  memory.update(
    [
      {
        topic: "決済ボタン",
        text: "青色",
        status: "proposal",
        sourceSequences: [1],
      },
    ],
    [source],
  );
  for (let sequence = 2; sequence < 60; sequence++)
    memory.remember({
      sequence,
      meetingId: "meeting",
      text: "次の別の話題です",
    });
  assert.equal(memory.context("決済ボタンの色", 3).sources[0].sequence, 1);
  const correction = {
    ...source,
    sequence: 60,
    text: "決済ボタンは赤色で決定します",
  };
  memory.remember(correction);
  memory.update(
    [
      {
        topic: "決済ボタン",
        text: "赤色",
        status: "decision",
        sourceSequences: [60],
      },
      {
        topic: "勝手な推測",
        text: "公開済み",
        status: "decision",
        sourceSequences: [999],
      },
    ],
    [correction],
  );
  const restored = new MeetingMemory(memory.snapshot());
  assert.equal(restored.decisions.length, 1);
  assert.equal(restored.decisions[0].text, "赤色");
  assert.equal(restored.decisions[0].sources[0].text, correction.text);
  assert.equal(restored.decisions[0].interpretation, true);
});

test("memory remains bounded and an incomplete utterance cannot establish a decision", () => {
  const memory = new MeetingMemory();
  for (let sequence = 1; sequence <= 250; sequence++)
    memory.remember({ sequence, text: "x".repeat(1000) });
  assert.ok(memory.sources.length <= 120);
  memory.update(
    [
      {
        topic: "未確定",
        text: "承認",
        status: "decision",
        sourceSequences: [1],
      },
    ],
    [{ sequence: 1, text: "途切れた発話", taskEligible: false }],
  );
  assert.equal(memory.decisions.length, 0);
});

test("only a complete correction request qualifies for immediate task steering", () => {
  assert.deepEqual(
    parseImmediateTaskInstruction("やっぱりボタンを小さくして"),
    {},
  );
  assert.deepEqual(
    parseImmediateTaskInstruction("井戸Bot、タスク abcd1234 を修正して"),
    { taskId: "abcd1234" },
  );
  for (const text of [
    "『やっぱり小さくして』という表示にして",
    "やっぱり小さくしてもいいかな",
    "やっぱり小さくして？",
    "やっぱり停止して",
    "今の作業は直したらよいかも",
  ])
    assert.equal(parseImmediateTaskInstruction(text), undefined, text);
  assert.equal(
    parseImmediateTaskInstruction("やっぱり小さくして", {
      requireWakeWord: true,
    }),
    undefined,
  );
});
