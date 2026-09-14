import type { AdminState } from "@ido/common-ui";

const operations: Record<string, string> = {
  "audio.transcribe": "文字起こし",
  "minutes.generate": "議事録生成",
  "answer.generate": "回答生成",
  "audio.speak": "読み上げ",
  "task.create": "タスク作成",
  "input.process": "入力処理",
  "input.dispatch": "プラグイン入力",
};

/** Count actual newline-delimited output, including multiline error details. */
export function diagnosticLines(entries: AdminState["diagnostics"]): string[] {
  return [...entries]
    .sort((a, b) => b.at - a.at)
    .flatMap((entry) => [
      `${new Date(entry.at).toLocaleString()}: ${operations[entry.operation] ?? entry.operation} · ${entry.source} [${entry.level === "warning" ? "一部失敗" : "エラー"}]`,
      `  ${entry.error.reason}`,
      "  " +
        [
          `エラーID: ${entry.id}`,
          `種類: ${entry.error.type}`,
          entry.error.code && `コード: ${entry.error.code}`,
          entry.error.status && `HTTP: ${entry.error.status}`,
          entry.error.cause && `通信原因: ${entry.error.cause}`,
          entry.error.parameter && `対象パラメータ: ${entry.error.parameter}`,
          entry.model && `モデル: ${entry.model}`,
          entry.error.requestId &&
            `OpenAI Request ID: ${entry.error.requestId}`,
          entry.eventId && `入力ID: ${entry.eventId}`,
          entry.meetingId && `会議ID: ${entry.meetingId}`,
          entry.messageId && `発言ID: ${entry.messageId}`,
        ]
          .filter(Boolean)
          .join(" · "),
    ])
    .flatMap((line) => line.split(/\r\n|[\n\r\u2028\u2029]/))
    .slice(0, 100);
}
