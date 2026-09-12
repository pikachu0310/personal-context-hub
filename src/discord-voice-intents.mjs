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
