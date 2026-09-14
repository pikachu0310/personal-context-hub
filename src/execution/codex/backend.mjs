import { CodexVoiceRunner } from "./runner.mjs";
import { executionState } from "../port.mjs";

// Adapt the existing runner's mutable workspace record to the data-only port.
// SDK thread objects remain in this layer. Their IDs are checkpointed so a new
// instance can resume without handing credentials or sessions to the engine.
export function createCodexBackend(
  config,
  { runner = new CodexVoiceRunner(config) } = {},
) {
  const activeWorkers = new Map();
  return {
    prepare: () => runner.prepare?.(),
    close: () => runner.close?.(),
    createCoordinator: runner.createCoordinator
      ? (options) => runner.createCoordinator(options)
      : undefined,
    reviewTask: runner.reviewTask
      ? async (request, options) =>
          structuredClone(
            await runner.reviewTask(structuredClone(request), options),
          )
      : undefined,
    investigateQuestion: runner.investigateQuestion
      ? (question, options) => runner.investigateQuestion(question, options)
      : undefined,
    steerTask: async (request, instruction) => {
      const worker = activeWorkers.get(request.id);
      return worker
        ? ((await runner.steerTask?.(worker, instruction)) ?? false)
        : false;
    },
    resetMeeting: () => runner.resetMeeting?.(),
    run: (text, options) => runner.run(text, options),
    observeMeeting: (observation, options) =>
      runner.observeMeeting(observation, options),
    async runTask(request, { checkpoint, flushSteering, ...options } = {}) {
      const worker = structuredClone(request);
      if (activeWorkers.has(request.id))
        throw new Error("Task execution is already active");
      activeWorkers.set(request.id, worker);
      worker.flushSteering = flushSteering;
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
        try {
          await checkpoint?.(snapshot());
        } finally {
          activeWorkers.delete(request.id);
        }
      }
    },
    async applyTask(request) {
      const worker = structuredClone(request);
      const value = await runner.applyTask(worker);
      return { value, state: executionState(worker) };
    },
  };
}
