import { setTimeout as delay } from "node:timers/promises";

// A validated model result is a lease on one exact context revision, not a
// permanent permission to speak. The transport checks it synchronously at play.
export function createSpeechTicket({
  getState,
  validate,
  targets,
  text,
  now = Date.now,
  ttlMs = 90_000,
  isCurrent = () => true,
}) {
  const expiresAt = now() + ttlMs;
  let validatedRevision;
  let cancelled = false;
  const canStart = () => {
    const state = getState();
    return (
      isCurrent() &&
      !cancelled &&
      now() < expiresAt &&
      !state.pendingTranscripts &&
      state.revision === validatedRevision
    );
  };
  return {
    canStart,
    async beforeStart({ signal } = {}) {
      while (
        isCurrent() &&
        !signal?.aborted &&
        !cancelled &&
        now() < expiresAt
      ) {
        const state = getState();
        const revision = state.revision;
        if (state.pendingTranscripts) {
          await delay(25, undefined, { signal });
          continue;
        }
        if (canStart()) return true;
        const decision = validate
          ? await validate(
              { targets, pendingReply: text, conversation: state.conversation },
              { signal },
            )
          : { decision: "keep" };
        const latest = getState();
        if (latest.revision !== revision || latest.pendingTranscripts) continue;
        if (decision.decision !== "keep") {
          cancelled = true;
          return false;
        }
        validatedRevision = revision;
        if (canStart()) return true;
      }
      return false;
    },
  };
}
