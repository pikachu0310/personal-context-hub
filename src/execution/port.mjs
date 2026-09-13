// The execution boundary contains only data and callbacks, never SDK instances.
// A backend implements run(text, options), observeMeeting(observation, options),
// and runTask(request, { signal, onProgress, checkpoint }). The task runner owns
// authorization, durable acceptance and delivery; the backend owns delegation.
const stateFields = [
  "execution",
  "codexThreadId", // legacy ID kept for old saved-state readers
  "workingDirectory",
  "baseCommit",
  "baselineTree",
  "baselineFingerprint",
  "applied",
  "appliedRevision",
  "appliedFileState",
  "artifacts",
  "profile",
  "evidence",
  "runRevision",
];
export function executionState(task) {
  return Object.fromEntries(
    stateFields
      .filter((key) => task[key] !== undefined)
      .map((key) => [key, structuredClone(task[key])]),
  );
}
function applyState(task, state = {}) {
  for (const key of stateFields) {
    if (Object.hasOwn(state, key)) task[key] = structuredClone(state[key]);
  }
}
export function bindExecution(backend) {
  if (!backend) throw new TypeError("execution backend is required");
  return {
    prepare: () => backend.prepare?.(),
    resetMeeting: () => backend.resetMeeting?.(),
    run: (text, options) => backend.run(text, options),
    observeMeeting: (observation, options) =>
      backend.observeMeeting(observation, options),
    async runTask(task, { signal, onProgress } = {}) {
      const request = {
        ...executionState(task),
        id: task.id,
        meetingId: task.meetingId,
        requestKey: task.requestKey,
        title: task.title,
        request: task.request,
        context: task.context,
        kind: task.kind,
        complexity: task.complexity,
        sourceSequences: structuredClone(task.sourceSequences),
        additionalInstruction: task.additionalInstruction,
      };
      const result = await backend.runTask(request, {
        signal,
        onProgress,
        checkpoint: async (state) => {
          applyState(task, state);
          await task.checkpoint?.();
        },
      });
      applyState(task, result.state);
      return result.text;
    },
    async applyTask(task) {
      const result = await backend.applyTask({
        id: task.id,
        ...executionState(task),
      });
      applyState(task, result.state);
      return result.value;
    },
  };
}
