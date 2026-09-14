import { normalizeExecutionPolicy } from "./work-policy.mjs";

// The conversation owns source authorization before calling this port. The
// queue owns durable acceptance, assignment, execution and delivery. Results
// and state events return through the queue's existing composition callbacks.
export function createWorkPort(queue) {
  const submit = async (request) => {
    if (!queue) return false;
    const task = structuredClone(request);
    task.executionPolicy = normalizeExecutionPolicy(task.executionPolicy);
    return queue.enqueueDurable(task);
  };
  return Object.freeze({
    submit,
    submitResearch: (request) =>
      submit({
        ...request,
        kind: "research",
        executionPolicy: {
          ...normalizeExecutionPolicy(request.executionPolicy),
          sandboxMode: "read-only",
        },
      }),
    // A control receipt confirms durable acceptance, not worker termination.
    control: async (control) =>
      structuredClone(
        (await queue?.handleVoiceControlDurable(structuredClone(control))) ??
          false,
      ),
    list: () => structuredClone(queue?.list() ?? []),
    getReceipt: (requestKey) => structuredClone(queue?.getReceipt(requestKey)),
    getResult: (taskId) => structuredClone(queue?.getTaskResult(taskId)),
  });
}
