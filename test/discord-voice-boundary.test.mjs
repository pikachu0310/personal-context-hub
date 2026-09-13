import assert from "node:assert/strict";
import test from "node:test";
import { DiscordVoiceMeetingSession } from "../src/discord-voice-session.mjs";
import { createIdobataMessageHandler } from "../src/discord-voice-commands.mjs";

const noop = async () => undefined;
const eventually = async (check) => {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("condition not reached");
};
function meeting(options = {}) {
  return new DiscordVoiceMeetingSession({
    transcribe: async () => "new audio",
    observe: async () =>
      JSON.stringify({ minutes: "new summary", shouldReply: false }),
    upsertLiveTranscript: noop,
    upsertMinutes: noop,
    postText: noop,
    synthesize: noop,
    playAudio: noop,
    logger: {},
    scheduleInterval: () => 0,
    cancelInterval: () => {},
    ...options,
  });
}
const initialState = () => ({
  meetingId: "old",
  minutes: "old summary",
  sequence: 1,
  statements: [
    {
      id: "old-statement",
      sequence: 1,
      text: "old words",
      archived: false,
      observed: false,
    },
  ],
});

test("text arriving while the old meeting is archived belongs to the new meeting and is not erased", async (t) => {
  let release;
  const block = new Promise((resolve) => {
    release = resolve;
  });
  const session = meeting({
    initialState: initialState(),
    archiveTranscript: async (statement) => {
      if (statement.text === "old words") await block;
    },
  });
  t.after(async () => {
    release();
    await session.stop();
  });
  const switching = session.newMeeting();
  const incoming = session.addText("new words", { userId: "owner" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  release();
  assert.equal(await switching, true);
  await incoming;
  assert.equal(session.statements.length, 1);
  assert.equal(session.statements[0].text, "new words");
  assert.equal(session.statements[0].meetingId, session.meetingId);
  assert.notEqual(session.meetingId, "old");
});

test("audio arriving during the meeting boundary waits and keeps a unique sequence", async (t) => {
  let release,
    transcribed = 0;
  const block = new Promise((resolve) => {
    release = resolve;
  });
  const session = meeting({
    initialState: initialState(),
    archiveTranscript: async (statement) => {
      if (statement.text === "old words") await block;
    },
    transcribe: async () => {
      transcribed++;
      return "new audio";
    },
  });
  t.after(async () => {
    release();
    await session.stop();
  });
  const switching = session.newMeeting();
  assert.equal(
    session.enqueue(Buffer.from("synthetic"), { userId: "owner" }),
    true,
  );
  assert.equal(transcribed, 0);
  release();
  assert.equal(await switching, true);
  await eventually(() => session.statements.length === 1);
  assert.equal(session.statements[0].text, "new audio");
  assert.equal(session.statements[0].meetingId, session.meetingId);
  assert.equal(session.statements[0].sequence, 1);
});

test("the first question in a new meeting waits for the observer reset", async (t) => {
  let release,
    resetting = false,
    phase = "old";
  const block = new Promise((resolve) => {
    release = resolve;
  });
  const observed = [];
  const session = meeting({
    observe: async () => {
      observed.push(phase);
      return JSON.stringify({ minutes: "new", shouldReply: false });
    },
  });
  t.after(async () => {
    release();
    await session.stop();
  });
  const handler = createIdobataMessageHandler({
    config: { guildId: "g", textChannelId: "c", allowedUserId: "owner" },
    session,
    resetMeeting: async () => {
      resetting = true;
      await block;
      phase = "new";
    },
  });
  const switching = handler({
    id: "new",
    guildId: "g",
    channelId: "c",
    author: { id: "owner" },
    content: "/ido new",
    channel: { send: noop },
  });
  await eventually(() => resetting);
  const incoming = session.addText("new question", {
    userId: "owner",
    taskEligible: false,
    requestReply: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(observed, []);
  release();
  await switching;
  await incoming;
  await eventually(() => observed.length === 1);
  assert.deepEqual(observed, ["new"]);
});

test("a failed observer reset retains the old meeting and releases incoming text", async (t) => {
  const session = meeting({ initialState: initialState() });
  t.after(() => session.stop());
  const switching = session.newMeeting(async () => {
    throw new Error("reset failed");
  });
  const incoming = session.addText("keep this correction", { userId: "owner" });
  assert.equal(await switching, false);
  await incoming;
  assert.equal(session.meetingId, "old");
  assert.equal(session.minutes, "old summary");
  assert.equal(session.statements.at(-1).text, "keep this correction");
});

test("a result saved across a meeting switch is reported as belonging to the previous meeting", async (t) => {
  let release;
  const posts = [];
  const session = meeting({
    initialState: { meetingId: "old" },
    checkpoint: async (state) => {
      if (state.meetingId === "old" && state.results.length)
        await new Promise((resolve) => {
          release = resolve;
        });
    },
    postText: async (content) => posts.push(content),
  });
  t.after(async () => {
    release?.();
    await session.stop();
  });
  const delivery = session.addTaskResult({
    id: "task01",
    title: "previous task",
    result: "old result detail",
    meetingId: "old",
    threadId: "thread01",
  });
  await eventually(() => release);
  assert.equal(await session.newMeeting(), true);
  release();
  await delivery;
  assert.deepEqual(session.results, []);
  assert.equal(posts.length, 1);
  assert.match(posts[0], /以前の会議/);
  assert.match(posts[0], /thread01/);
  assert.doesNotMatch(posts[0], /old result detail/);
});
