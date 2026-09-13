import { withTimeout } from "../shared.mjs";

export async function deliverSpeech(
  text,
  { synthesize, playAudio, stageTimeouts, signal },
) {
  const audio = await withTimeout(
    (stageSignal) => synthesize(text, { signal: stageSignal }),
    stageTimeouts.synthesizing,
    "synthesizing meeting response",
    signal,
  );
  await withTimeout(
    (stageSignal) => playAudio(audio, { signal: stageSignal }),
    stageTimeouts.speaking,
    "speaking meeting response",
    signal,
  );
}
