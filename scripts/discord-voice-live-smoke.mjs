import OpenAI from "openai";
import { DiscordLiveBridge } from "../src/discord-voice-live.mjs";
import { ttsPcm24kMonoToDiscordRaw } from "../src/discord-voice-audio.mjs";

// Synthetic audio only. This script never joins Discord or starts a worker.
const client = new OpenAI();
const utterance = "井戸Bot、いまの試験タスクの結果を確認して教えてください。";
const speech = await client.audio.speech.create({
  model: "gpt-4o-mini-tts",
  voice: "alloy",
  input: utterance,
  response_format: "pcm",
});
const raw = ttsPcm24kMonoToDiscordRaw(Buffer.from(await speech.arrayBuffer()));
let outputBytes = 0,
  delegated = false,
  firstAudioAt;
let inputTranscript = "",
  outputTranscript = "";
const events = {};
const startedAt = Date.now();
const bridge = new DiscordLiveBridge({
  apiKey: process.env.OPENAI_API_KEY,
  logger: {},
  output: {
    clear() {},
    close() {},
    append: (pcm) => {
      outputBytes += pcm.length;
      firstAudioAt ??= Date.now();
    },
  },
  onDelegation: (event) => {
    delegated = true;
    bridge.commentary(
      "音声接続の試験を受け取りました。この試験では開発タスクは実行していません。",
      event.delegation.id,
    );
  },
  onFailure: () => {
    throw new Error("Live disconnected during smoke");
  },
});
try {
  await bridge.start();
  bridge.socket.on("event", (event) => {
    events[event.type] = (events[event.type] ?? 0) + 1;
    if (event.type === "session.input_transcript.delta")
      inputTranscript += event.delta;
    if (event.type === "session.output_transcript.delta")
      outputTranscript += event.delta;
  });
  bridge.speakerStart("synthetic-speaker");
  for (let offset = 0; offset < raw.length; offset += 3840) {
    bridge.input("synthetic-speaker", raw.subarray(offset, offset + 3840));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const endedAt = Date.now();
  bridge.speakerEnd("synthetic-speaker");
  bridge.recordStatement({
    meetingId: "synthetic-smoke",
    sequence: 1,
    startedAt,
    speakerName: "試験音声",
    text: utterance,
  });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && (!delegated || outputBytes < 9600))
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (!delegated || outputBytes < 9600) {
    console.log(
      JSON.stringify({
        events,
        inputTranscript,
        outputTranscript,
        outputBytes,
        metrics: bridge.metrics,
      }),
    );
    throw new Error("Live did not complete delegation and audio output");
  }
  console.log(
    JSON.stringify({
      sessionStarted: true,
      clientDelegationReceived: delegated,
      outputAudioBytes: outputBytes,
      firstAudioAfterSyntheticInputMs: firstAudioAt - endedAt,
      elapsedMs: Date.now() - startedAt,
      discordTested: false,
      humanParticipantsTested: 0,
    }),
  );
} finally {
  bridge.close();
}
