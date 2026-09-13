import { withTimeout } from "../shared.mjs";

export async function deliverSpeech(
  text,
  { synthesize, playAudio, stageTimeouts, signal, beforeStart, canStart },
) {
  const audio = await withTimeout(
    (stageSignal) => synthesize(text, { signal: stageSignal }),
    stageTimeouts.synthesizing,
    "synthesizing meeting response",
    signal,
  );
  await withTimeout(
    async (stageSignal) => {
      if (beforeStart && !(await beforeStart({ signal: stageSignal }))) return;
      return playAudio(audio, { signal: stageSignal, beforeStart, canStart });
    },
    stageTimeouts.speaking,
    "speaking meeting response",
    signal,
  );
}
