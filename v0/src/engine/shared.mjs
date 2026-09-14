import { VoiceServiceError } from "./errors.mjs";
export const MAX_OUTPUT_CHARACTERS = 1_900;
export const MAX_TRANSCRIPT_CHARACTERS = 8_000;
export const MAX_RESPONSE_CHARACTERS = 12_000;
const TRUNCATION_SUFFIX = " …（長さ上限で省略）";
export const DEFAULT_STAGE_TIMEOUTS = Object.freeze({
  transcribing: 120_000,
  running_codex: 900_000,
  posting: 30_000,
  synthesizing: 120_000,
  speaking: 300_000,
});

export function safeSliceEnd(text, end) {
  if (end <= 0 || end >= text.length) return end;
  const previous = text.charCodeAt(end - 1);
  const next = text.charCodeAt(end);
  return previous >= 0xd800 &&
    previous <= 0xdbff &&
    next >= 0xdc00 &&
    next <= 0xdfff
    ? end - 1
    : end;
}

export async function withTimeout(operation, timeoutMs, label, parentSignal) {
  if (parentSignal?.aborted) {
    throw (
      parentSignal.reason ??
      new VoiceServiceError(
        "SERVICE_STOPPED",
        `${label} cancelled because the voice service stopped.`,
        "音声サービスを停止しました。",
      )
    );
  }
  const controller = new AbortController();
  let timer;
  let removeParentAbort = () => undefined;
  try {
    const parentAbort = new Promise((_, reject) => {
      if (!parentSignal) return;
      const abort = () => {
        const reason =
          parentSignal.reason ??
          new VoiceServiceError(
            "SERVICE_STOPPED",
            `${label} cancelled because the voice service stopped.`,
            "音声サービスを停止しました。",
          );
        controller.abort(reason);
        reject(reason);
      };
      if (parentSignal.aborted) {
        abort();
        return;
      }
      parentSignal.addEventListener("abort", abort, { once: true });
      removeParentAbort = () =>
        parentSignal.removeEventListener("abort", abort);
    });
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      parentAbort,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const timeout = new VoiceServiceError(
            "STAGE_TIMEOUT",
            `${label} timed out after ${timeoutMs}ms`,
            "処理が制限時間を超えました。次の発話を受け付けます。",
          );
          reject(timeout);
          controller.abort(timeout);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    removeParentAbort();
  }
}

export function boundText(text, maximum, suffix = TRUNCATION_SUFFIX) {
  if (!Number.isInteger(maximum) || maximum <= 0) return "";
  const normalized = String(text ?? "").trim();
  if (normalized.length <= maximum) return normalized;
  const safeSuffix = suffix.length < maximum ? suffix : "";
  const end = safeSliceEnd(normalized, maximum - safeSuffix.length);
  return `${normalized.slice(0, end).trimEnd()}${safeSuffix}`;
}

export function boundRecentText(text, maximum) {
  const normalized = String(text ?? "").trim();
  if (normalized.length <= maximum) return normalized;
  const prefix = "（前半を省略。以下は最新の内容）\n";
  let start = normalized.length - (maximum - prefix.length);
  const first = normalized.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start++;
  return prefix + normalized.slice(start);
}

export function speechExcerpt(text, maximum = 1_200) {
  if (!Number.isInteger(maximum) || maximum <= 0) return "";
  const normalized = String(text ?? "")
    .replace(/https?:\/\/\S+/g, "リンク")
    .trim();
  if (normalized.length <= maximum) return normalized;
  const safeSuffix =
    TRUNCATION_SUFFIX.length < maximum ? TRUNCATION_SUFFIX : "";
  const budget = maximum - safeSuffix.length;
  const candidate = normalized.slice(0, safeSliceEnd(normalized, budget));
  const boundary = Math.max(
    candidate.lastIndexOf("。"),
    candidate.lastIndexOf("\n"),
  );
  const excerpt = candidate.slice(
    0,
    boundary > budget * 0.6 ? boundary + 1 : budget,
  );
  return `${excerpt.trimEnd()}${safeSuffix}`;
}

export function formatElapsedTime(elapsedMs) {
  const numeric = Number(elapsedMs);
  const totalSeconds = Number.isFinite(numeric)
    ? Math.max(0, Math.round(numeric / 1_000))
    : 0;
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
}
