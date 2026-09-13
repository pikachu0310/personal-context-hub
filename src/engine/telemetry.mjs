import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

// Observability is optional and cannot participate in engine control flow.
export function safeNotify(sink, event) {
  try {
    Promise.resolve(sink?.(event)).catch(() => {});
  } catch {
    /* isolated observer */
  }
}
export function createTelemetry(sink) {
  const context = new AsyncLocalStorage();
  const sessionId = randomUUID();
  const emit = (event) =>
    safeNotify(sink, {
      sessionId,
      ...context.getStore(),
      at: Date.now(),
      ...event,
    });
  const scope = (fields, work) =>
    context.run({ ...context.getStore(), ...fields }, work);
  const span = (stage, fields = {}) => {
    const base = {
      ...context.getStore(),
      stage,
      spanId: randomUUID(),
      ...fields,
    };
    let ended = false;
    emit({ ...base, status: fields.status ?? "running" });
    const finish = (status = "completed", extra = {}) => {
      if (ended) return;
      ended = true;
      emit({ ...base, ...extra, status });
    };
    finish.update = (fields) => {
      if (!ended) emit({ ...base, ...fields });
    };
    finish.spanId = base.spanId;
    return finish;
  };
  const wrap = (stage, fn, describe = () => ({})) =>
    fn &&
    (async (...args) => {
      const fields = describe(...args);
      return scope(fields, async () => {
        const finish = span(stage);
        const signal = args[1]?.signal;
        const aborted = () =>
          finish(
            /TIMEOUT/i.test(signal.reason?.code ?? "")
              ? "failed"
              : "interrupted",
            {
              reason: /TIMEOUT/i.test(signal.reason?.code ?? "")
                ? "timeout"
                : "aborted",
            },
          );
        signal?.addEventListener("abort", aborted, { once: true });
        try {
          if (signal?.aborted) aborted();
          const callArgs =
            stage === "PLAYBACK"
              ? [
                  args[0],
                  {
                    ...args[1],
                    onPlaybackState: (state) => finish.update(state),
                  },
                ]
              : args;
          const result = await scope({ parentId: finish.spanId }, () =>
            fn(...callArgs),
          );
          finish(
            stage === "STT" && !result ? "skipped" : "completed",
            stage === "STT"
              ? { text: typeof result === "string" ? result : undefined }
              : {},
          );
          return result;
        } catch (error) {
          finish(signal?.aborted ? "interrupted" : "failed", {
            reason: /TIMEOUT/i.test(error?.code ?? "")
              ? "timeout"
              : "operation_failed",
          });
          throw error;
        } finally {
          signal?.removeEventListener("abort", aborted);
        }
      });
    });
  const taskStates = new Map();
  const taskState = (task) => {
    const status =
      {
        queued: "waiting",
        running: "running",
        cancelled: "interrupted",
        rejected: "skipped",
        awaiting_receipt: "waiting",
      }[task.state] ?? task.state;
    const fields = {
      taskId: task.id,
      runId: String(task.runRevision ?? 0),
      title: task.title,
      stage: ["queued", "awaiting_receipt"].includes(task.state)
        ? "QUEUE"
        : "EXECUTE",
      inputIds: (task.sourceSequences ?? []).map(
        (n) => `${task.meetingId}:I-${n}`,
      ),
      status,
      reason:
        task.state === "queued"
          ? "execution_capacity"
          : task.state === "awaiting_receipt"
            ? "receipt_pending"
            : undefined,
    };
    const signature = JSON.stringify(fields);
    const previous = taskStates.get(task.id);
    if (previous?.signature === signature) return;
    const samePhase =
      previous?.status === status && previous?.stage === fields.stage;
    if (!samePhase)
      previous?.finish?.(
        ["failed", "interrupted", "skipped"].includes(status)
          ? status
          : "completed",
      );
    const finish = samePhase
      ? previous?.finish
      : ["waiting", "running"].includes(status)
        ? span(fields.stage, fields)
        : undefined;
    taskStates.set(task.id, { signature, status, stage: fields.stage, finish });
    if (taskStates.size > 1000)
      taskStates.delete(taskStates.keys().next().value);
    emit({ ...fields, spanId: `task-${task.id}` });
  };
  return { emit, scope, span, wrap, sessionId, taskState };
}
