import { CodexVoiceRunner } from "./runner.mjs";
import { executionState } from "../port.mjs";

// Adapt the existing runner's mutable workspace record to the data-only port.
// SDK thread objects remain in this layer. Their IDs are checkpointed so a new
// instance can resume without handing credentials or sessions to the engine.
export function createCodexBackend(
  config,
  { runner = new CodexVoiceRunner(config) } = {},
) {
  return {
    prepare: () => runner.prepare?.(),
    resetMeeting: () => runner.resetMeeting?.(),
    run: (text, options) => runner.run(text, options),
    observeMeeting: (observation, options) =>
      runner.observeMeeting(observation, options),
    async runTask(request, { checkpoint, ...options } = {}) {
      const worker = structuredClone(request);
      worker.codexThreadId ??= worker.execution?.threadId;
      const snapshot = () => {
        worker.codexThreadId ??= worker.codexThread?.id;
        worker.execution = { backend: "codex", threadId: worker.codexThreadId };
        return executionState(worker);
      };
      worker.checkpoint = () => checkpoint?.(snapshot());
      try {
        const text = await runner.runTask(worker, options);
        return { text, state: snapshot() };
      } finally {
        // Interrupted runs also retain the resume handle and verification state.
        await checkpoint?.(snapshot());
      }
    },
    async applyTask(request) {
      const worker = structuredClone(request);
      const value = await runner.applyTask(worker);
      return { value, state: executionState(worker) };
    },
  };
}
