import assert from "node:assert/strict";
import test from "node:test";
import { ConversationAudio } from "../src/output/audio/session.js";
import { validateMediaInput } from "../src/adapters/plugins/broker.js";
import type {
  ConversationInput,
  InputContext,
  PluginOutput,
} from "@ido/common/contracts/plugins";

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
  await manager.handleMedia(
    event({ activity: "end", silenceMs: 1000 }),
    firstContext,
  );
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

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 150; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("audio state was not reached");
}
function heldPlayback(outputs: PluginOutput[]) {
  const ctx = context(outputs);
  const pending = new Map<
    string,
    { resolve(): void; reject(error: Error): void }
  >();
  ctx.deliver = async (output) => {
    outputs.push(output);
    if (output.kind === "audio")
      await new Promise<void>((resolve, reject) => {
        pending.set(output.candidateId!, { resolve, reject });
      });
    if (output.kind === "audio-stop") {
      pending
        .get(output.candidateId!)
        ?.reject(new Error("AUDIO_PLAYBACK_INTERRUPTED"));
      pending.delete(output.candidateId!);
    }
  };
  return {
    ctx,
    finish: () => {
      for (const item of pending.values()) item.resolve();
      pending.clear();
    },
  };
}

test("backchannel STT preserves encoded playback; interruption rewrites only after final STT", async (t) => {
  const outputs: PluginOutput[] = [],
    synth: string[] = [],
    reviews: any[] = [];
  const held = heldPlayback(outputs);
  const manager = new ConversationAudio({
    synthesize: async (text) => {
      synth.push(text);
      return "opus";
    },
    recordAssistant() {},
    onDelegation() {},
    reviewSpeech: async (review) => {
      reviews.push(review);
      return {
        candidateId: review.candidateId,
        revision: review.revision,
        action: review.state === "interrupted" ? "replace" : "continue",
        text: review.state === "interrupted" ? "新しい質問と必要な要点" : null,
      };
    },
  });
  t.after(async () => {
    held.finish();
    await manager.close();
  });
  await manager.handleMedia(event({ audio: "wav" }), held.ctx);
  const initial = manager.reply({
    text: "元の長い回答",
    sourceIds: ["question"],
  });
  await waitFor(() => outputs.some((output) => output.kind === "audio"));
  await manager.handleMedia(event({ activity: "start" }), held.ctx);
  manager.observeMessage({
    id: "backchannel",
    authorId: "discord:100",
    meetingId: "meeting",
    text: "うん",
    at: 2000,
  });
  await manager.handleMedia(
    event({ activity: "end", silenceMs: 1000 }),
    held.ctx,
  );
  await waitFor(() => reviews.length === 1);
  assert.equal(
    outputs.filter((output) => output.kind === "audio-stop").length,
    0,
  );
  assert.deepEqual(synth, ["元の長い回答"]);
  const long = event({ capture: { ...event().capture!, utteranceId: "long" } });
  await manager.handleMedia({ ...long, activity: "start" }, held.ctx);
  await manager.handleMedia({ ...long, activity: "interrupt" }, held.ctx);
  manager.transcription(long, held.ctx, true);
  await manager.handleMedia(
    { ...long, activity: "end", silenceMs: 1000 },
    held.ctx,
  );
  await initial;
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(reviews.length, 1);
  manager.observeMessage({
    id: "new-question",
    authorId: "discord:100",
    meetingId: "meeting",
    text: "別の点を教えて",
    at: 3000,
  });
  manager.transcription(long, held.ctx, false);
  await waitFor(
    () => outputs.filter((output) => output.kind === "audio").length === 2,
  );
  assert.deepEqual(synth, ["元の長い回答", "新しい質問と必要な要点"]);
  // A normal model reply covering that same revision must not duplicate speech.
  await manager.reply({ text: "同じ質問への別回答", reason: "direct" });
  assert.equal(synth.length, 2);
});

test("end arriving before final segment registration cannot release speech early", async (t) => {
  const outputs: PluginOutput[] = [];
  const manager = new ConversationAudio({
    synthesize: async () => "opus",
    recordAssistant() {},
    onDelegation() {},
  });
  t.after(() => manager.close());
  const ctx = context(outputs);
  await manager.handleMedia(event({ activity: "start" }), ctx);
  await manager.handleMedia(
    event({
      activity: "end",
      silenceMs: 1000,
      capture: { ...event().capture!, segmentIndex: 1 },
    }),
    ctx,
  );
  const reply = manager.reply({ text: "final segment待ち" });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(outputs.filter((output) => output.kind === "audio").length, 0);
  manager.transcription(event({ eventId: "utterance:segment:0" }), ctx, false);
  await reply;
  assert.equal(outputs.filter((output) => output.kind === "audio").length, 1);
});

test("Live interruption closes the old provider, accepts new input and fences every late callback", async (t) => {
  const outputs: PluginOutput[] = [],
    providers: Array<ReturnType<typeof fakeLive>> = [],
    callbacks: any[] = [],
    records: any[] = [];
  const manager = new ConversationAudio({
    mode: "live",
    createLiveSession: async (options) => {
      const provider = fakeLive();
      providers.push(provider);
      callbacks.push(options);
      return provider.live;
    },
    synthesize: async () => {
      throw new Error("unexpected TTS");
    },
    recordAssistant: (record) => {
      records.push(record);
    },
    onDelegation() {},
    reviewSpeech: async (review) => ({
      candidateId: review.candidateId,
      revision: review.revision,
      action: "replace",
      text: "短い再回答",
    }),
  });
  t.after(() => manager.close());
  const ctx = context(outputs);
  await manager.handleMedia(event({ audioFrame: frame }), ctx);
  callbacks[0].output.append(Buffer.alloc(960));
  callbacks[0].onAssistantTranscript({ text: "生成した元の回答" });
  await manager.handleMedia(event({ activity: "start" }), ctx);
  const before = outputs.filter(
    (output) => output.kind === "audio-frame",
  ).length;
  callbacks[0].output.append(Buffer.alloc(960));
  assert.equal(
    outputs.filter((output) => output.kind === "audio-frame").length,
    before + 1,
  );
  await manager.handleMedia(event({ activity: "interrupt" }), ctx);
  assert.equal(providers[0].live.ready, false);
  const stoppedCount = outputs.length,
    recordCount = records.length;
  callbacks[0].output.append(Buffer.alloc(960));
  callbacks[0].output.clear();
  callbacks[0].onAssistantTranscript({ text: "late" });
  assert.equal(outputs.length, stoppedCount);
  assert.equal(records.length, recordCount);
  await manager.handleMedia(
    event({ audioFrame: { ...frame, sequence: 1 } }),
    ctx,
  );
  assert.equal(providers[1].inputs.length, 1);
  callbacks[1].output.append(Buffer.alloc(960));
  assert.equal(
    outputs.filter((output) => output.kind === "audio-frame").length,
    before + 1,
  );
  manager.observeMessage({
    id: "new",
    meetingId: "meeting",
    authorId: "discord:100",
    text: "追加の質問",
    at: 3000,
  });
  await manager.handleMedia(event({ activity: "end", silenceMs: 1000 }), ctx);
  await waitFor(() =>
    providers.some((provider) => provider.comments.includes("短い再回答")),
  );
  assert.equal(providers[1].live.ready, false);
  assert.deepEqual(providers.at(-1)!.comments, ["短い再回答"]);
  assert.equal(providers.at(-1)!.statements.at(-1).text, "追加の質問");
});

test("a late model answer is reviewed against newer context before synthesis can play", async (t) => {
  const outputs: PluginOutput[] = [],
    reviews: any[] = [];
  let resolveReview!: (decision: any) => void;
  const manager = new ConversationAudio({
    synthesize: async () => "opus",
    recordAssistant() {},
    onDelegation() {},
    reviewSpeech: (review) => {
      reviews.push(review);
      return new Promise((resolve) => {
        resolveReview = resolve;
      });
    },
  });
  t.after(() => manager.close());
  await manager.handleMedia(event({ audio: "wav" }), context(outputs));
  const previous = manager.turns.revision;
  manager.observeMessage({
    id: "correction",
    authorId: "human",
    meetingId: "meeting",
    text: "もう解決した",
    at: 1,
  });
  const reply = manager.reply({ text: "古い回答", contextRevision: previous });
  await waitFor(() => reviews.length === 1);
  assert.equal(outputs.filter((output) => output.kind === "audio").length, 0);
  assert.equal(reviews[0].conversation.at(-1).text, "もう解決した");
  resolveReview({ ...reviews[0], action: "discard", text: null });
  await reply;
  assert.equal(outputs.filter((output) => output.kind === "audio").length, 0);
});

test("media extensions reject invalid silence and retain explicit interrupt events", () => {
  validateMediaInput(event({ activity: "interrupt" }));
  validateMediaInput(event({ activity: "end", silenceMs: 1000 }));
  for (const invalid of [
    event({ activity: "end", silenceMs: -1 }),
    event({ activity: "end", silenceMs: 1001 }),
    event({ activity: "end", silenceMs: NaN }),
    event({ activity: "start", silenceMs: 1000 }),
    event({ activity: "interrupt", text: "authority" }),
  ])
    assert.throws(() => validateMediaInput(invalid));
});

test("explicit quiet fences an older model result and late STT from its old epoch", async (t) => {
  const outputs: PluginOutput[] = [];
  const manager = new ConversationAudio({
    synthesize: async () => "opus",
    recordAssistant() {},
    onDelegation() {},
  });
  t.after(() => manager.close());
  const ctx = context(outputs);
  await manager.handleMedia(event({ audio: "wav" }), ctx);
  const revision = manager.turns.revision;
  await manager.handleMedia(
    event({
      activity: "quiet",
      replyTo: { ...event().replyTo, speechEpoch: 2 },
    }),
    ctx,
  );
  await manager.reply({ text: "停止前の回答", contextRevision: revision });
  manager.observeMessage({
    id: "late-stt",
    meetingId: "meeting",
    authorId: "human",
    text: "停止前の質問",
    at: 1,
  });
  await manager.reply({
    text: "遅着した文字起こしへの回答",
    contextRevision: manager.turns.revision,
    replyTo: event().replyTo,
  });
  assert.equal(outputs.filter((output) => output.kind === "audio").length, 0);
  await manager.reply({
    text: "新しい質問への回答",
    contextRevision: manager.turns.revision,
    replyTo: { ...event().replyTo, speechEpoch: 2 },
  });
  assert.equal(outputs.filter((output) => output.kind === "audio").length, 1);
});
