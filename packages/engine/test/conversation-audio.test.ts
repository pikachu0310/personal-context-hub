import assert from "node:assert/strict";
import test from "node:test";
import { ConversationAudio } from "../src/output/audio/session.js";
import { validateMediaInput } from "../src/adapters/plugins/broker.js";
import type {
  ConversationInput,
  InputContext,
  PluginOutput,
} from "../../common/src/contracts/plugins.js";

function event(overrides: Partial<ConversationInput> = {}): ConversationInput {
  return {
    eventId: "audio-1",
    meetingId: "meeting",
    subject: "100",
    capture: {
      sessionId: "session",
      utteranceId: "utterance",
      segmentIndex: 0,
      startedAt: 1000,
      complete: true,
    },
    replyTo: { channelId: "text", speechEpoch: 1, audioSessionId: "session" },
    ...overrides,
  };
}
function context(outputs: PluginOutput[], valid = () => true): InputContext {
  return {
    pluginId: "discord",
    actor: { id: "discord:100", name: "One", role: "member" },
    valid,
    deliver: async (output) => {
      outputs.push(output);
    },
    publish() {},
  };
}
function fakeLive() {
  const inputs: any[] = [],
    statements: any[] = [],
    comments: string[] = [],
    activity: any[] = [];
  const live = {
    ready: false,
    start: async () => {
      live.ready = true;
    },
    close: () => {
      live.ready = false;
    },
    input: (subject: string, pcm: Buffer) => inputs.push([subject, pcm]),
    speakerStart: (subject: string) => activity.push(["start", subject]),
    speakerEnd: (subject: string) => activity.push(["end", subject]),
    recordStatement: (statement: any) => statements.push(statement),
    commentary: (text: string) => comments.push(text),
    silence() {},
    resume() {},
  };
  return { live, inputs, statements, comments, activity };
}
const frame = {
  pcm: Buffer.alloc(3840).toString("base64"),
  sampleRate: 48000 as const,
  channels: 2 as const,
  format: "pcm16" as const,
  sequence: 0,
};

test("text speech uses latest fenced voice route and completes synthesis/playback without Live", async () => {
  const outputs: PluginOutput[] = [],
    synthesized: string[] = [];
  const manager = new ConversationAudio({
    synthesize: async (text) => {
      synthesized.push(text);
      return "encoded-opus";
    },
    recordAssistant() {},
    onDelegation() {},
  });
  await manager.handleMedia(
    event({ audio: "synthetic-wav" }),
    context(outputs),
  );
  manager.observeMessage({
    id: "message-1",
    meetingId: "meeting",
    authorId: "discord:100",
    text: "質問",
    at: 1000,
  });
  await manager.reply({ text: "回答", sourceIds: ["message-1"] });
  assert.deepEqual(synthesized, ["回答"]);
  const audio = outputs.find((output) => output.kind === "audio")!;
  assert.equal(audio.audioFormat, "ogg-opus");
  assert.equal(audio.replyTo!.audioSessionId, "session");
  assert.equal(audio.replyTo!.speechEpoch, 1);
  await manager.close();
});

test("Live keeps per-user PCM separate, records attributed STT, and owns direct voice replies", async () => {
  const outputs: PluginOutput[] = [],
    transcripts: any[] = [],
    delegates: any[] = [];
  const provider = fakeLive();
  let callbacks: any;
  const manager = new ConversationAudio({
    mode: "live",
    createLiveSession: async (options) => {
      callbacks = options;
      return provider.live;
    },
    synthesize: async () => {
      assert.fail("Live must not invoke TTS");
    },
    recordAssistant: (record) => {
      transcripts.push(record);
    },
    onDelegation: (notice) => {
      delegates.push(notice);
    },
  });
  const firstContext = context(outputs);
  await manager.handleMedia(event({ activity: "start" }), firstContext);
  await manager.handleMedia(event({ audioFrame: frame }), firstContext);
  const secondContext = {
    ...firstContext,
    actor: { id: "discord:200", name: "Two", role: "member" as const },
  };
  await manager.handleMedia(event({ audioFrame: frame }), secondContext);
  manager.observeMessage({
    id: "message",
    meetingId: "meeting",
    authorId: "discord:100",
    authorName: "One",
    text: "調べて",
    at: 2000,
    capture: event().capture,
  });
  await manager.reply({ text: "direct", reason: "direct" });
  await manager.reply({ text: "verified result", reason: "backend" });
  assert.deepEqual(
    provider.inputs.map(([subject]) => subject),
    ["discord:100", "discord:200"],
  );
  assert.deepEqual(provider.comments, ["verified result"]);
  assert.equal(provider.statements[0].id, "message");
  assert.equal(provider.statements[0].startedAt, 1000);
  assert.equal(provider.statements[0].speakerName, "One");
  callbacks.onAssistantTranscript({
    text: "Live actual words",
    playbackStatus: "unknown",
  });
  callbacks.onDelegation({ sourceIds: ["message"] });
  callbacks.output.append(Buffer.alloc(9600));
  await new Promise(setImmediate);
  assert.equal(transcripts[0].meetingId, "meeting");
  assert.deepEqual(delegates[0].sourceIds, ["message"]);
  assert.ok(
    outputs.some(
      (output) =>
        output.kind === "audio-frame" &&
        output.audioFormat === "pcm16-24000-mono",
    ),
  );
  await manager.handleMedia(event({ activity: "end" }), firstContext);
  await manager.close();
});

test("mode change during Live startup cannot activate a stale provider or emit late output", async () => {
  const outputs: PluginOutput[] = [];
  const provider = fakeLive();
  let started!: () => void, callbacks: any;
  provider.live.start = () =>
    new Promise<void>((resolve) => {
      started = () => {
        provider.live.ready = true;
        resolve();
      };
    });
  const manager = new ConversationAudio({
    mode: "live",
    createLiveSession: async (options) => {
      callbacks = options;
      return provider.live;
    },
    synthesize: async () => "opus",
    recordAssistant() {},
    onDelegation() {},
  });
  const starting = manager.handleMedia(
    event({ audioFrame: frame }),
    context(outputs),
  );
  while (!started) await new Promise(setImmediate);
  await manager.setMode("text-speech");
  started();
  await starting;
  const before = outputs.length;
  callbacks.output.append(Buffer.alloc(960));
  assert.equal(outputs.length, before);
  assert.equal(manager.mode, "text-speech");
  assert.equal(provider.inputs.length, 0);
  await manager.close();
});

test("quiet's new epoch cannot be overwritten by frames from the same older utterance", async () => {
  const outputs: PluginOutput[] = [];
  const manager = new ConversationAudio({
    synthesize: async () => "opus",
    recordAssistant() {},
    onDelegation() {},
  });
  const ctx = context(outputs);
  await manager.handleMedia(
    event({
      activity: "quiet",
      replyTo: { channelId: "text", speechEpoch: 2, audioSessionId: "session" },
    }),
    ctx,
  );
  await manager.handleMedia(event({ audioFrame: frame }), ctx);
  await manager.reply({ text: "new response" });
  assert.equal(
    outputs.find((output) => output.kind === "audio")!.replyTo!.speechEpoch,
    2,
  );
  await manager.close();
});

test("revoked contexts suppress both generated PCM and recorded Live output", async () => {
  let allowed = true,
    callbacks: any;
  const outputs: PluginOutput[] = [],
    records: any[] = [];
  const provider = fakeLive();
  const manager = new ConversationAudio({
    mode: "live",
    createLiveSession: async (options) => {
      callbacks = options;
      return provider.live;
    },
    synthesize: async () => "opus",
    recordAssistant: (record) => {
      records.push(record);
    },
    onDelegation() {},
  });
  await manager.handleMedia(
    event({ audioFrame: frame }),
    context(outputs, () => allowed),
  );
  allowed = false;
  const count = outputs.length;
  callbacks.output.append(Buffer.alloc(960));
  callbacks.onAssistantTranscript({ text: "late" });
  await manager.reply({ text: "late", reason: "backend" });
  assert.equal(outputs.length, count);
  assert.equal(records.length, 0);
  await manager.close();
});

test("media contract rejects unbounded or malformed frames and mixed authorization inputs", () => {
  validateMediaInput(event({ audioFrame: frame }));
  validateMediaInput(event({ activity: "start" }));
  for (const invalid of [
    event({
      audioFrame: { ...frame, pcm: Buffer.alloc(24580).toString("base64") },
    }),
    event({ audioFrame: { ...frame, pcm: "AAAA" } }),
    event({ audioFrame: frame, command: "task", text: "do work" }),
    event({ audioFrame: frame, capture: undefined }),
    event({ conversationMode: "invalid" as any }),
  ])
    assert.throws(() => validateMediaInput(invalid));
});

test("speech waits for accepted STT after the human audio stream ends", async () => {
  const outputs: PluginOutput[] = [];
  const manager = new ConversationAudio({
    synthesize: async () => "opus",
    recordAssistant() {},
    onDelegation() {},
  });
  const input = event({ audio: "wav" });
  const ctx = context(outputs);
  await manager.handleMedia(input, ctx);
  manager.transcription(input, ctx, true);
  manager.transcription(input, ctx, true);
  await manager.handleMedia(event({ activity: "end" }), ctx);
  const speaking = manager.reply({ text: "pending answer" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(
    outputs.some((output) => output.kind === "audio"),
    false,
  );
  manager.transcription(input, ctx, false);
  await speaking;
  assert.equal(outputs.filter((output) => output.kind === "audio").length, 1);
  await manager.close();
});
