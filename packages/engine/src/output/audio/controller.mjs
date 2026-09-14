import {
  VoiceServiceError,
  DEFAULT_STAGE_TIMEOUTS,
  createTelemetry,
  safeNotify,
} from "./support.mjs";
import { createSpeechTicket } from "./ticket.mjs";
import { deliverSpeech } from "./deliver.mjs";

function stoppedReason() {
  return new VoiceServiceError(
    "SPEECH_STOPPED",
    "Speech stopped by an operator",
    "読み上げを停止しました。",
  );
}

// Owns candidates, cancellation, validation leases, and serialized TTS/playback.
// Conversation state is read through a snapshot callback. The audio transport
// still owns its human-speech gate and must honor beforeStart/canStart at play.
export function createSpeechController({
  getState,
  synthesize,
  playAudio,
  validate,
  signal,
  stageTimeouts = DEFAULT_STAGE_TIMEOUTS,
  telemetry = createTelemetry(),
  onError,
  onValidated,
}) {
  if (typeof getState !== "function")
    throw new TypeError("speech getState is required");
  let queue = Promise.resolve();
  let pending = 0;
  let closed = false;
  let cancellation = new AbortController();
  const candidates = new Map();
  const latestOrders = new Map();

  const cancel = (reason = stoppedReason()) => {
    const count = pending;
    cancellation.abort(reason);
    cancellation = new AbortController();
    candidates.clear();
    return count;
  };

  return {
    get pending() {
      return pending;
    },
    idle: () => queue,
    cancel,
    close() {
      closed = true;
      cancel();
      return queue;
    },
    enqueue(
      { text, targets = [], meetingId, modeRevision } = {},
      options = {},
    ) {
      const initial = getState();
      if (
        closed ||
        initial.closed ||
        initial.enabled === false ||
        initial.paused ||
        !text
      )
        return Promise.resolve();
      const candidateMeetingId = meetingId ?? initial.meetingId;
      const candidateModeRevision = modeRevision ?? initial.modeRevision;
      const key = targets
        .map((target) =>
          String(target.text ?? "")
            .normalize("NFKC")
            .replace(/[\s、。！？!?]/gu, " ")
            .trim(),
        )
        .join("\n");
      const order = Math.max(
        -1,
        ...targets.map((target) => target.sequence ?? -1),
      );
      const historyKey = `${candidateMeetingId}:${key}`;
      if (key && (latestOrders.get(historyKey) ?? -1) > order)
        return Promise.resolve();
      if (key) latestOrders.set(historyKey, order);
      if (latestOrders.size > 200)
        latestOrders.delete(latestOrders.keys().next().value);
      const candidate = { order };
      if (key) candidates.set(historyKey, candidate);
      const speechSignal = AbortSignal.any(
        [signal, cancellation.signal, options.signal].filter(Boolean),
      );
      const isCurrent = () => {
        const state = getState();
        return (
          !closed &&
          !state.closed &&
          state.enabled !== false &&
          !state.paused &&
          !speechSignal.aborted &&
          state.meetingId === candidateMeetingId &&
          (candidateModeRevision === undefined ||
            candidateModeRevision === state.modeRevision) &&
          (!key || candidates.get(historyKey) === candidate) &&
          targets.every((target) => {
            if (!target.resultId) return true;
            const current = state.results?.find(
              (result) => result.id === target.resultId,
            );
            return (
              current &&
              !current.superseded &&
              (current.runRevision ?? 0) === target.runRevision
            );
          })
        );
      };
      const ticket = createSpeechTicket({
        isCurrent,
        text,
        targets,
        validate: validate
          ? async (input, validationOptions) => {
              const decision = await validate(input, validationOptions);
              safeNotify(onValidated, {
                decision: decision.decision,
                sourceSequences: targets
                  .map((target) => target.sequence)
                  .filter(Number.isInteger),
              });
              return decision;
            }
          : undefined,
        getState: () => {
          const state = getState();
          return {
            revision: state.revision,
            pendingTranscripts: state.pendingTranscripts,
            conversation: (state.conversation ?? []).filter(
              (item) =>
                !targets.some(
                  (target) =>
                    target.sequence === item.sequence ||
                    item.sourceSequences?.includes(target.sequence),
                ),
            ),
          };
        },
      });
      const finishWait = telemetry.span("TTS", {
        status: "waiting",
        reason: "playback_queue",
      });
      pending++;
      queue = queue
        .then(() => {
          finishWait(speechSignal.aborted ? "interrupted" : "completed");
          if (!isCurrent()) return;
          return deliverSpeech(text, {
            synthesize,
            playAudio,
            stageTimeouts: { ...DEFAULT_STAGE_TIMEOUTS, ...stageTimeouts },
            signal: speechSignal,
            beforeStart: ticket.beforeStart,
            canStart: ticket.canStart,
          });
        })
        .catch((error) => {
          if (!closed && !getState().closed && error?.code !== "SPEECH_STOPPED")
            safeNotify(onError, error);
        })
        .finally(() => {
          pending--;
          if (key && candidates.get(historyKey) === candidate)
            candidates.delete(historyKey);
        });
      return queue;
    },
  };
}
