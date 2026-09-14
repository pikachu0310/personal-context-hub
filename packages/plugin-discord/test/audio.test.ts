import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { AudioPlayerStatus, VoiceConnectionStatus } from "@discordjs/voice";
import { VoiceCapture } from "../src/input/capture.js";
import { normalizeInput } from "../src/input/normalize.js";
import { DiscordAudioOutput } from "../src/output/audio.js";
import type { DiscordState } from "../src/runtime/state.js";

async function until(predicate: () => unknown) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(setImmediate);
  }
  assert.fail("expected asynchronous state was not reached");
}
const source = {
  sessionId: "session",
  userId: "100",
  guildId: "1",
  channelId: "3",
  meetingId: "meeting",
  projectId: "project",
  speechEpoch: 1,
};
test("per-subject capture splits long speech losslessly and retains source timing and finality", () => {
  const events: any[] = [];
  const capture = new VoiceCapture(source, (event) => events.push(event), {
    startedAt: 1000,
    maximumSeconds: 0.02,
  });
  const pcm = Buffer.alloc(3840 * 2 + 8, 1);
  capture.push(pcm.subarray(0, 40));
  capture.push(pcm.subarray(40));
  capture.finish();
  capture.finish();
  const segments = events.filter((event) => event.audio);
  assert.deepEqual(
    Buffer.concat(
      segments.map((event) => Buffer.from(event.audio, "base64").subarray(44)),
    ),
    pcm,
  );
  assert.deepEqual(
    segments.map((event) => event.capture.segmentIndex),
    [0, 1, 2],
  );
  assert.deepEqual(
    segments.map((event) => event.capture.complete),
    [false, false, true],
  );
  assert.deepEqual(
    segments.map((event) => event.capture.startedAt),
    [1000, 1020, 1040],
  );
  assert.equal(events.filter((event) => event.activity === "end").length, 1);
  assert.ok(
    events.every(
      (event) =>
        event.userId === "100" && event.capture.sessionId === "session",
    ),
  );
  assert.ok(
    events
      .filter((event) => event.audioFrame)
      .every(
        (event) => Buffer.from(event.audioFrame.pcm, "base64").length <= 3840,
      ),
  );
});
test("exact segment boundary remains complete and speakers never share capture identity", () => {
  const events: any[] = [];
  const first = new VoiceCapture(source, (event) => events.push(event), {
    maximumSeconds: 0.02,
  });
  const second = new VoiceCapture(
    { ...source, userId: "200" },
    (event) => events.push(event),
    { maximumSeconds: 0.02 },
  );
  first.push(Buffer.alloc(3840));
  second.push(Buffer.alloc(3840, 2));
  first.finish();
  second.finish();
  const segments = events.filter((event) => event.audio);
  assert.equal(segments.length, 2);
  assert.ok(segments.every((event) => event.capture.complete));
  assert.notEqual(
    segments[0].capture.utteranceId,
    segments[1].capture.utteranceId,
  );
});

test("capture errors flush a final incomplete segment without authorizing partial speech", () => {
  const events: any[] = [];
  const capture = new VoiceCapture(source, (event) => events.push(event));
  capture.push(Buffer.alloc(3840));
  capture.finish(false);
  capture.finish(true);
  const segments = events.filter((event) => event.audio);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].capture.final, true);
  assert.equal(segments[0].capture.complete, false);
  assert.equal(events.filter((event) => event.activity === "end").length, 1);
});
test("normalized frames retain capture metadata but reject old voice/config bindings", () => {
  const config = {
    guildId: "1",
    textChannelId: "2",
    meetingId: "meeting",
    projectId: "project",
  };
  const event: any = {
    ...source,
    eventId: "frame-1",
    capture: {
      sessionId: "session",
      utteranceId: "turn",
      segmentIndex: 0,
      startedAt: 1,
    },
    audioFrame: {
      pcm: "AAAAAA==",
      sampleRate: 48000,
      channels: 2,
      format: "pcm16",
      sequence: 0,
    },
  };
  const normalized = normalizeInput(event, config, "3", "session")!;
  assert.equal(normalized.subject, "100");
  assert.deepEqual(normalized.audioFrame, event.audioFrame);
  assert.equal(normalized.replyTo!.audioSessionId, "session");
  assert.equal(normalizeInput(event, config, "3", "new-session"), undefined);
  assert.equal(
    normalizeInput(event, { ...config, meetingId: "other" }, "3", "session"),
    undefined,
  );
  assert.equal(
    normalizeInput(
      event,
      { ...config, userPolicy: "allowlist", allowedUserIds: "" },
      "3",
      "session",
    ),
    undefined,
  );
});

function outputFixture() {
  const resources: any[] = [];
  const player = new EventEmitter() as any;
  player.state = { status: AudioPlayerStatus.Idle };
  player.stop = () => {
    const old = player.state;
    player.state = { status: AudioPlayerStatus.Idle };
    player.emit("stateChange", old, player.state);
  };
  player.play = (resource: any) => {
    resources.push(resource);
    player.state = { status: AudioPlayerStatus.Playing };
  };
  const state = {
    config: { textChannelId: "text" },
    speechEpoch: 1,
    audioSessionId: "session",
    activeSpeakers: new Set(),
    player,
    voice: { state: { status: VoiceConnectionStatus.Ready } },
  } as unknown as DiscordState;
  const output = new DiscordAudioOutput(state, 0, ((stream: any) => ({
    stream,
  })) as any);
  const message = {
    kind: "audio",
    eventId: "answer",
    candidateId: "candidate",
    channelId: "text",
    speechEpoch: 1,
    audioSessionId: "session",
    audio: Buffer.from("synthetic opus").toString("base64"),
    audioFormat: "ogg-opus",
  };
  return { state, player, output, resources, message };
}
test("encoded audio RPC waits for playback and human activity interrupts without blocking stop", async () => {
  const { output, resources, message } = outputFixture();
  let settled = false;
  const playing = output.deliver(message).finally(() => {
    settled = true;
  });
  const expected = assert.rejects(playing, /AUDIO_PLAYBACK_INTERRUPTED/);
  await until(() => resources.length === 1);
  assert.equal(settled, false);
  output.speakerStart("speaker");
  await expected;
  output.speakerEnd("speaker");
  output.invalidate();
});
test("epoch changes discard queued and delayed audio and a stopped candidate cannot restart", async () => {
  const { output, state, resources, message } = outputFixture();
  const first = assert.rejects(
    output.deliver(message),
    /AUDIO_PLAYBACK_INTERRUPTED/,
  );
  const second = assert.rejects(
    output.deliver({ ...message, candidateId: "second" }),
    /AUDIO_PLAYBACK_DISCARDED/,
  );
  await until(() => resources.length === 1);
  state.speechEpoch++;
  output.invalidate();
  await Promise.all([first, second]);
  await assert.rejects(output.deliver(message), /AUDIO_PLAYBACK_DISCARDED/);
  assert.equal(resources.length, 1);
});
test("Live PCM framing validates size, converts 24k mono to Discord stereo, and fences late frames", async () => {
  const { output, resources, message } = outputFixture();
  const pcm = Buffer.alloc(960);
  for (let index = 0; index < pcm.length; index += 2)
    pcm.writeInt16LE(123, index);
  const frame = {
    ...message,
    kind: "audio-frame",
    audioFormat: "pcm16-24000-mono",
    audioSequence: 0,
    audio: pcm.toString("base64"),
  };
  await output.deliver(frame);
  await output.deliver(frame);
  assert.equal(resources.length, 1);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const raw = resources[0].stream.read() as Buffer;
  assert.equal(raw.length >= 3840, true);
  assert.equal(raw.readInt16LE(0), 123);
  assert.equal(raw.readInt16LE(6), 123);
  await output.deliver({ ...message, kind: "audio-stop" });
  await output.deliver({ ...frame, audioSequence: 1 });
  assert.equal(resources.length, 1);
  assert.throws(
    () =>
      output.deliver({
        ...frame,
        audio: Buffer.alloc(9602).toString("base64"),
      }),
    /INVALID_AUDIO_FRAME/,
  );
  output.invalidate();
});
