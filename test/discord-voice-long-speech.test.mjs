import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PcmSegmentBuffer } from "../src/engine/input/audio.mjs";
import { SpeechTurnAssembler } from "../src/engine/input/utterances.mjs";
import { buildMeetingObservationPrompt } from "../src/execution/codex/runner.mjs";
import { DiscordVoiceMeetingSession } from "../src/adapters/discord/sessions.mjs";
import { subscribeToAllowedSpeaker } from "../src/adapters/discord/transport.mjs";
const noop = async () => undefined;

test("late corrections survive both observation prompt construction and oversized utterance context", () => {
  const correction = "訂正。公開をやめてローカルだけで検証してください。";
  const full = "説明。".repeat(3500) + correction;
  const prompt = buildMeetingObservationPrompt({
    statements: [{ sequence: 1, userId: "owner", text: full }],
    ownerUserId: "owner",
  });
  const payload = JSON.parse(prompt.split("\n").at(-1));
  assert.ok(payload.attributedStatements[0].text.endsWith(correction));
  const turns = new SpeechTurnAssembler();
  turns.register("long", 0, { sequence: 1, userId: "owner" });
  turns.settle("long", 0, {
    text: "最初の説明。".repeat(4000) + correction,
    archived: true,
  });
  turns.finish("long", 1);
  const [statement] = turns.drain();
  assert.equal(statement.taskEligible, false);
  assert.ok(statement.text.endsWith(correction));
  const session = meeting({ initialState: { statements: [statement] } });
  assert.match(session.getContextSnapshot(), /公開をやめてローカルだけで検証/);
  return session.stop();
});
async function eventually(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
}
const metadata = (index) => ({
  userId: "owner",
  speakerName: "話者",
  utteranceId: "speech",
  segmentIndex: index,
});
function meeting(options = {}) {
  return new DiscordVoiceMeetingSession({
    logger: {},
    ownerUserId: "owner",
    tasksEnabled: true,
    requireWakeWord: true,
    transcribe: noop,
    upsertLiveTranscript: noop,
    upsertMinutes: noop,
    postText: noop,
    synthesize: noop,
    playAudio: noop,
    scheduleInterval: () => 0,
    cancelInterval: () => {},
    ...options,
  });
}

test("long PCM speech is segmented at a quiet boundary without losing or duplicating frames", () => {
  const buffer = new PcmSegmentBuffer({
    minimumAudioMs: 250,
    maximumAudioSeconds: 1,
  });
  const pcm = Buffer.alloc(192_004 * 3, 3);
  pcm.fill(0, 153_600, 172_800);
  const segments = [
    ...buffer.push(pcm.subarray(0, 40_000)),
    ...buffer.push(pcm.subarray(40_000)),
  ];
  assert.ok(buffer.byteLength < 192_000);
  segments.push(buffer.finish());
  assert.equal(segments[0].length, 172_800);
  assert.deepEqual(Buffer.concat(segments), pcm);
  assert.ok(
    segments.every(
      (segment) => segment.length <= 192_000 && segment.length % 4 === 0,
    ),
  );
  assert.equal(buffer.byteLength, 0);
});

test("segmented speech waits for its ending and restores recognition order before authorizing a task", async (t) => {
  const resolvers = [],
    dispatched = [],
    archived = [];
  const session = meeting({
    transcriptionConcurrency: 2,
    transcribe: () => new Promise((resolve) => resolvers.push(resolve)),
    archiveTranscript: async (part) => archived.push(part.text),
    observe: async ({ statements }) =>
      JSON.stringify({
        minutes: "青へ訂正",
        tasks: [
          { title: "青いボタン", sourceSequences: [statements[0].sequence] },
        ],
      }),
    enqueueTask: async (task) => {
      dispatched.push(task);
      return true;
    },
  });
  t.after(() => session.stop());
  session.enqueue(Buffer.alloc(4), metadata(0));
  session.enqueue(Buffer.alloc(4), metadata(1));
  await eventually(() => resolvers.length === 2);
  resolvers[1]("訂正します。青いボタンにしてください。");
  await eventually(() => session.activeTranscriptions === 1);
  assert.equal(await session.observeNow(), false);
  resolvers[0]("井戸Bot、赤いボタンを作ってください。");
  await eventually(() => session.activeTranscriptions === 0);
  assert.equal(await session.observeNow(), false);
  await session.finishUtterance("speech", 2);
  assert.equal(await session.observeNow(), true);
  assert.equal(dispatched.length, 1);
  assert.match(dispatched[0].request, /赤いボタン[\s\S]*訂正[\s\S]*青いボタン/);
  assert.equal(archived.length, 2);
});

test("a dropped segment keeps recognized speech but cannot authorize a partial instruction", async (t) => {
  let resolve, observed;
  const session = meeting({
    maximumPendingTranscriptions: 1,
    transcribe: () =>
      new Promise((done) => {
        resolve = done;
      }),
    observe: async ({ statements }) => {
      observed = statements;
      return JSON.stringify({
        minutes: "一部欠落",
        tasks: [
          {
            title: "unsafe partial",
            sourceSequences: [statements[0].sequence],
          },
        ],
      });
    },
    enqueueTask: () => assert.fail("incomplete speech must not execute"),
  });
  t.after(() => session.stop());
  session.enqueue(Buffer.alloc(4), metadata(0));
  session.enqueue(Buffer.alloc(4), metadata(1));
  await session.finishUtterance("speech", 2);
  await eventually(() => resolve);
  resolve("井戸Bot、赤いボタンを作ってください。");
  await eventually(() => session.activeTranscriptions === 0);
  await session.observeNow();
  assert.equal(observed[0].taskEligible, false);
  assert.match(observed[0].text, /赤いボタン/);
});

test("restart retains already recognized segments without treating an unfinished turn as a command", async (t) => {
  let saved;
  const session = meeting({
    checkpoint: async (state) => {
      saved = structuredClone(state);
    },
    transcribe: async () => "井戸Bot、作業を開始して",
  });
  t.after(() => session.stop());
  session.enqueue(Buffer.alloc(4), metadata(0));
  await eventually(() => session.activeTranscriptions === 0);
  const restored = meeting({ initialState: saved });
  t.after(() => restored.stop());
  assert.equal(restored.statements.length, 1);
  assert.equal(restored.statements[0].taskEligible, false);
  assert.match(restored.statements[0].text, /作業を開始して/);
});

test("an ongoing captured utterance prevents a meeting reset even before its first segment is ready", async (t) => {
  const session = meeting();
  t.after(() => session.stop());
  session.beginUtterance("speech", { userId: "owner" });
  assert.equal(await session.newMeeting(), false);
  await session.finishUtterance("speech", 0);
  assert.equal(await session.newMeeting(), true);
});

test("observation and capture share one in-flight archive write", async (t) => {
  let release,
    calls = 0;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const session = meeting({
    archiveTranscript: async () => {
      calls++;
      await pending;
    },
    observe: async () =>
      JSON.stringify({ minutes: "記録", shouldReply: false }),
  });
  t.after(() => session.stop());
  const input = session.addText("保存途中の発言", { userId: "owner" });
  const observation = session.observeNow();
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(calls, 1);
  } finally {
    release();
    await input;
    await observation;
  }
});

test("Discord decoder keeps receiving past the former turn limit and closes one coherent utterance", async () => {
  const speaking = new EventEmitter(),
    decoder = new EventEmitter(),
    opus = new EventEmitter();
  let destroyed = 0;
  decoder.destroy = () => {
    destroyed++;
  };
  opus.destroy = () => {
    destroyed++;
  };
  opus.pipe = () => decoder;
  const enqueued = [],
    endings = [];
  subscribeToAllowedSpeaker({
    connection: { receiver: { speaking, subscribe: () => opus } },
    config: {
      voiceMode: "meeting",
      allowedUserId: "owner",
      maximumAudioSeconds: 1,
      minimumAudioMs: 250,
      silenceMs: 1000,
    },
    session: {
      enqueue: (wav, details) => {
        enqueued.push({ wav, details });
        return true;
      },
      finishUtterance: async (...args) => endings.push(args),
    },
    postText: noop,
    logger: {},
    createDecoder: () => decoder,
  });
  speaking.emit("start", "owner");
  decoder.emit("data", Buffer.alloc(192_000 * 2 + 4, 3));
  decoder.emit("end");
  decoder.emit("close");
  assert.equal(destroyed, 0);
  assert.equal(enqueued.length, 3);
  assert.equal(endings.length, 1);
  assert.equal(endings[0][1], 3);
  assert.deepEqual(
    enqueued.map(({ details }) => details.segmentIndex),
    [0, 1, 2],
  );
  assert.equal(
    new Set(enqueued.map(({ details }) => details.utteranceId)).size,
    1,
  );
});
