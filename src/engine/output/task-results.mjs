import { randomUUID } from "node:crypto";
import { withTimeout, DEFAULT_STAGE_TIMEOUTS } from "../shared.mjs";
import { formatVerificationEvidence } from "../evidence.mjs";

// Stage order and idempotency keys are stable across restart and the v1 state format.
export async function deliverTaskResults(
  task,
  { presentation, persist, loadSurface, onResult, signal, isClosed, log },
) {
  try {
    while (task.resultDeliveries?.length && !isClosed()) {
      const delivery = task.resultDeliveries[0];
      const revision =
        delivery.runRevision ??
        delivery.evidence?.runRevision ??
        delivery.artifacts?.runRevision;
      const revisionLabel = revision ? ` (実行 r${revision})` : "";
      delivery.id ??= randomUUID();
      await persist({ strict: true });
      const surface = task.surface ?? (await loadSurface(task));
      const post = typeof surface === "function" ? surface : surface?.post;
      if (!post) throw new Error("Task result surface is unavailable");
      const stages = [
        (options) =>
          post(
            presentation.resultHeader(revisionLabel, delivery.evidence),
            options,
          ),
        ...presentation
          .splitText(delivery.result)
          .map((chunk) => (options) => post(chunk, options)),
      ];
      if (delivery.artifacts) {
        stages.push((options) =>
          post(presentation.artifacts(delivery.artifacts), options),
        );
        // Production surfaces (including restored ones) attach the exact saved revision.
        stages.push((options) =>
          surface?.postArtifacts?.(
            delivery.artifacts,
            delivery.evidence,
            options,
          ),
        );
      }
      stages.push(
        (options) =>
          post(
            presentation.taskCompleted(task, delivery, revisionLabel),
            options,
          ),
        (options) => {
          const state = task.state;
          const controlVersion = task.controlVersion ?? 0;
          const isCurrent = () =>
            task.runRevision === revision &&
            task.state === state &&
            task.state === delivery.state &&
            (task.controlVersion ?? 0) === controlVersion;
          if (!isCurrent()) return;
          return surface?.update?.({
            signal: options.signal,
            state,
            elapsedMs: delivery.elapsedMs,
            pendingInstructions: task.instructions.length,
            isCurrent,
          });
        },
        (options) =>
          onResult(
            {
              id: task.id,
              title: task.title,
              state: delivery.state,
              result: delivery.result,
              verification: formatVerificationEvidence(delivery.evidence),
              runRevision: revision,
              threadId: surface?.threadId ?? task.threadId,
              artifacts: delivery.artifacts,
              meetingId: task.meetingId,
            },
            options,
          ),
      );
      for (let index = delivery.nextStep ?? 0; index < stages.length; index++) {
        await withTimeout(
          (signal) =>
            stages[index]({
              signal,
              idempotencyKey: `task-result:${delivery.id}:${index}`,
            }),
          DEFAULT_STAGE_TIMEOUTS.posting,
          "delivering saved task result",
          signal,
        );
        delivery.nextStep = index + 1;
        await persist();
      }
      task.resultDeliveries.shift();
      task.resultDeliveryPending = Boolean(task.resultDeliveries.length);
      await persist();
    }
  } catch {
    task.resultDeliveryPending = true;
    await persist();
    log("task_result_delivery_failed", { taskId: task.id });
  }
}
