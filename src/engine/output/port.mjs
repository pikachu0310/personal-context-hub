const noop = async () => undefined;

// Missing optional surfaces are explicit capabilities, not transport failures.
// Task surfaces use opaque threadId/starterId strings for v1 state compatibility.
export function normalizeOutput(output) {
  if (typeof output?.postText !== "function")
    throw new TypeError("output.postText is required");
  const capabilities = {
    audio: false,
    transcript: false,
    minutes: false,
    tasks: false,
    ...output.capabilities,
  };
  for (const [capability, method] of [
    ["audio", "playAudio"],
    ["transcript", "upsertLiveTranscript"],
    ["minutes", "upsertMinutes"],
    ["tasks", "createTaskThread"],
  ]) {
    if (capabilities[capability] && typeof output[method] !== "function")
      throw new TypeError(`output.${method} is required for ${capability}`);
  }
  const method = (name) => output[name]?.bind(output);
  const createSurface = async (task) => ({
    threadId: task.threadId ?? task.id,
    post: method("postText"),
    update: noop,
  });
  return {
    capabilities,
    presentation: output.presentation,
    stopSpeech: capabilities.audio ? method("stopSpeech") : undefined,
    postText: method("postText"),
    playAudio: capabilities.audio ? method("playAudio") : undefined,
    upsertLiveTranscript: capabilities.transcript
      ? method("upsertLiveTranscript")
      : noop,
    upsertMinutes: capabilities.minutes ? method("upsertMinutes") : noop,
    createTaskThread: capabilities.tasks
      ? method("createTaskThread")
      : createSurface,
    restoreTaskSurface: capabilities.tasks
      ? (method("restoreTaskSurface") ??
        (() => {
          throw new Error(
            "output.restoreTaskSurface is required to restore tasks",
          );
        }))
      : createSurface,
  };
}
