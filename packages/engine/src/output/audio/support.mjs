export class VoiceServiceError extends Error {
  constructor(code, message, userMessage) {
    super(message);
    this.code = code;
    this.userMessage = userMessage;
  }
}
export const DEFAULT_STAGE_TIMEOUTS = Object.freeze({
  synthesizing: 60_000,
  speaking: 60_000,
});
export function safeNotify(sink, event) {
  try {
    Promise.resolve(sink?.(event)).catch(() => {});
  } catch {
    /* optional observer */
  }
}
export function createTelemetry() {
  return { span: () => () => {} };
}
export async function withTimeout(
  operation,
  milliseconds,
  label,
  parentSignal,
) {
  parentSignal?.throwIfAborted();
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([parentSignal, controller.signal])
    : controller.signal;
  let timer, abort;
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(signal)),
      new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
        timer = setTimeout(
          () =>
            controller.abort(
              new VoiceServiceError(
                "STAGE_TIMEOUT",
                `${label} timed out`,
                "音声処理が時間切れになりました。",
              ),
            ),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}
