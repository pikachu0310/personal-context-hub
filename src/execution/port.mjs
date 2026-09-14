import {
  normalizeExecutionPolicy,
  restrictExecutionPolicy,
} from "../engine/work-policy.mjs";

// The execution boundary contains only data and callbacks, never SDK instances.
// A backend implements run(text, options), observeMeeting(observation, options),
// and runTask(request, { signal, onProgress, checkpoint }). The task runner owns
// authorization, durable acceptance and delivery; the backend owns delegation.
const stateFields = [
  "issueId",
  "assignedAgentId",
  "assignedAgentName",
  "assignedAgentTransport",
  "assignmentReason",
  "remoteExecution",
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
  "usage",
  "usageHistory",
  "effectiveExecutionPolicy",
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
    if (!Object.hasOwn(state, key)) continue;
    task[key] =
      key === "effectiveExecutionPolicy"
        ? restrictExecutionPolicy(
            task.executionPolicy,
            task.effectiveExecutionPolicy,
            state[key],
          )
        : structuredClone(state[key]);
  }
}
function taskRequest(task) {
  return {
    ...executionState(task),
    ...structuredClone({
      id: task.id,
      meetingId: task.meetingId,
      requestKey: task.requestKey,
      title: task.title,
      request: task.request,
      context: task.context,
      kind: task.kind,
      complexity: task.complexity,
      executionPolicy: normalizeExecutionPolicy(task.executionPolicy),
      sourceSequences: task.sourceSequences,
      sourceStatements: task.sourceStatements,
      acceptanceCriteria: task.acceptanceCriteria,
      modelSelection: task.modelSelection,
      specRevision: task.specRevision,
      activeSpecRevision: task.activeSpecRevision,
      additionalInstruction: task.additionalInstruction,
      additionalInstructionSource: task.additionalInstructionSource,
    }),
  };
}
export function bindExecution(backend) {
  if (!backend) throw new TypeError("execution backend is required");
  return {
    prepare: () => backend.prepare?.(),
    close: () => backend.close?.(),
    investigateQuestion: backend.investigateQuestion
      ? (question, options) => backend.investigateQuestion(question, options)
      : undefined,
    steerTask: backend.steerTask
      ? (task, instruction) =>
          backend.steerTask(
            { id: task.id, ...executionState(task) },
            instruction,
          )
      : undefined,
    resetMeeting: () => backend.resetMeeting?.(),
    run: (text, options) => backend.run(text, options),
    observeMeeting: (observation, options) =>
      backend.observeMeeting(observation, options),
    reviewTask: backend.reviewTask
      ? async (task, options) =>
          structuredClone(
            await backend.reviewTask(
              {
                ...taskRequest(task),
                result: task.result,
                resultMetadata: structuredClone(task.resultMetadata),
              },
              options,
            ),
          )
      : undefined,
    async runTask(task, { signal, onProgress, onEvent } = {}) {
      const request = taskRequest(task);
      const result = await backend.runTask(request, {
        signal,
        onProgress,
        onEvent,
        flushSteering: () => task.flushSteering?.(),
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
