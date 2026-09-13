const stopVerb =
  "(?:停止(?:して(?:ください)?)?|中止(?:して(?:ください)?)?|キャンセル(?:して(?:ください)?)?|止めて(?:ください)?|stop|cancel)[。.!！\\s]*";
const namedStop = new RegExp(
  `^(?:タスク(?:id)?\\s*)?([a-z0-9_-]{4,80})\\s*(?:を)?\\s*${stopVerb}$`,
  "iu",
);
const currentStop = new RegExp(
  `^(?:(?:今の|現在の)?(?:作業|タスク)を)?${stopVerb}$`,
  "iu",
);

// Only a complete, directly addressed stop is eligible for the immediate path.
// Quotations, questions, compound requests, and uncertain speech stay with the observer.
export function parseImmediateTaskStop(text) {
  const addressed = String(text ?? "")
    .trim()
    .match(
      /^(?:井戸(?:bot|ボット)|[いイ][どド](?:ぼっと|ボット)|コーデックス|codex)[、,：:\s]*([\s\S]+)$/iu,
    );
  if (!addressed) return undefined;
  const named = addressed[1].match(namedStop);
  if (named) return { taskId: named[1] };
  return currentStop.test(addressed[1]) ? {} : undefined;
}

export function isImmediateTaskStatus(text, { explicitlyAsked = false } = {}) {
  const normalized = String(text ?? "").trim();
  const addressed = normalized.match(
    /^(?:井戸(?:bot|ボット)|[いイ][どド](?:ぼっと|ボット)|コーデックス|codex)[、,：:\s]*([\s\S]+)$/iu,
  );
  const body = addressed?.[1] ?? (explicitlyAsked ? normalized : "");
  return /^(?:今の|現在の)?(?:作業状況|タスク(?:の)?状況|進捗(?:状況)?)(?:(?:を)?教えて(?:ください)?|(?:は)?[?？]|(?:は)?どう(?:なってる|なっていますか))?[。.!！?？\s]*$/u.test(
    body,
  );
}

const speechStop = new RegExp(
  `^(?:今の|現在の)?(?:読み上げ|読みあげ)\\s*(?:を)?\\s*${stopVerb}$`,
  "iu",
);
export function isImmediateSpeechStop(text) {
  const addressed = String(text ?? "")
    .trim()
    .match(
      /^(?:井戸(?:bot|ボット)|[いイ][どド](?:ぼっと|ボット)|コーデックス|codex)[、,：:\s]*([\s\S]+)$/iu,
    );
  return Boolean(addressed && speechStop.test(addressed[1]));
}

export function parseImmediateTaskInstruction(
  text,
  { requireWakeWord = false } = {},
) {
  const normalized = String(text ?? "").trim();
  const addressed = normalized.match(
    /^(?:井戸(?:bot|ボット)|[いイ][どド](?:ぼっと|ボット)|コーデックス|codex)[、,：:\s]*([\s\S]+)$/iu,
  );
  if (requireWakeWord && !addressed) return undefined;
  const body = addressed?.[1] ?? normalized;
  if (
    /[「」『』"`?？]|(?:かも|かな|たら|なら|しないで|停止|中止|キャンセル|止めて)/u.test(
      body,
    )
  )
    return undefined;
  if (
    !/(?:して|戻して|直して|変えて|大きくして|小さくして)(?:ください|下さい|お願い)?[。.!！\s]*$/u.test(
      body,
    )
  )
    return undefined;
  const named = body.match(
    /^(?:タスク(?:id)?\s*)([a-z0-9_-]{4,80})[、,:：\s]*(?:は|を)?/iu,
  );
  if (named) return { taskId: named[1] };
  return /^(?:やっぱり|今の(?:作業|タスク|版)|さっきの(?:作業|タスク|版)|大きすぎる|小さすぎる|少し戻して)/u.test(
    body,
  )
    ? {}
    : undefined;
}
