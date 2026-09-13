import { boundText, formatElapsedTime } from "../shared.mjs";
import { formatVerificationEvidence } from "../evidence.mjs";

// Outputs supply presentation independently of the engine. Plain text is the default.
export function createPresentation({
  bold = String,
  code = String,
  italic = String,
  escape = String,
  reference = (id) => (id ? ` (${id})` : ""),
  statusHelp = "作業一覧でIDを確認できます。",
  stopHelp = "作業一覧でIDを確認し、対象IDを指定して停止してください。",
  receiptHelp = (id) => `作業一覧で確認し、ID ${id} を指定して取り消せます。`,
  contextHelp = "全文は共有コンテキストで確認できます。",
} = {}) {
  return {
    maximumText: 12_000,
    maximumTranscript: 16_000,
    splitText: (text) =>
      String(text ?? "").trim() ? [String(text).trim()] : [],
    escapeText: escape,
    formatTranscript: (statements, maximum = 16_000) =>
      boundText(
        [...statements]
          .sort(
            (a, b) =>
              (a.startedAt ?? 0) - (b.startedAt ?? 0) ||
              (a.sequence ?? 0) - (b.sequence ?? 0),
          )
          .map((s) => `${s.speakerName ?? s.userId ?? "不明な話者"}: ${s.text}`)
          .join("\n"),
        maximum,
      ),
    transcript: (text) => `🎙️ ${bold("聞き取った内容")}\n${text}`,
    resultHeader: (revisionLabel, evidence) =>
      `📦 ${bold("実行結果")}${revisionLabel}\n${formatVerificationEvidence(evidence)}`,
    artifacts: (artifacts) =>
      `🔬 ${bold("確認用の成果")}\nworkspace: ${artifacts.workingDirectory}\npatch: ${artifacts.patchPath}\n変更状態:\n${boundText(artifacts.status || "差分なし", 900)}\n元の作業場所へは自動反映しません。`,
    taskCompleted: (task, delivery, revisionLabel) =>
      delivery.pendingInstructions
        ? `⏭️ ${bold("追加指示へ続行")} ${task.id}${revisionLabel}\n残り: ${delivery.pendingInstructions}件`
        : `✅ ${bold("Codexタスク完了")} ${task.id}${revisionLabel}\n${escape(task.title)}\n所要時間: ${formatElapsedTime(delivery.elapsedMs)}`,
    taskStarted: (task, continuation) =>
      continuation
        ? `🔁 ${bold("追加指示の処理を開始")} ${code(task.id)}\n残り: ${task.instructions.length}件`
        : `🧰 ${bold("Codexタスク開始")} ${code(task.id)}\n${escape(task.title)}`,
    taskFailed: (task, error) =>
      `⚠️ ${bold("Codexタスク失敗")} ${code(task.id)}\n${error}`,
    taskCancelled: (task) =>
      `⏹️ ${bold("Codexタスク中止")} ${code(task.id)}${task.cancelledInstructionCount ? `\n未処理の追加指示 ${task.cancelledInstructionCount}件も破棄しました。` : ""}`,
    taskLabel: (id, title) => `${code(id)} ${escape(title)}`,
    historyHelp: (count) => `履歴は${count}件です。${statusHelp}`,
    stopHelp: () => stopHelp,
    pendingReceipt: (task) =>
      `依頼「${escape(task.title)}」（${task.id}）は会議に保存済みです。作業の受付を再試行しています。${receiptHelp(task.id)}`,
    meetingResult: (result, previous) =>
      previous
        ? `📦 以前の会議のタスクが完了しました: ${escape(result.title)}${reference(result.threadId)}`
        : `📦 ${bold(escape(result.title))} ${code(result.id)}\n${result.verification ? result.verification + "\n" : ""}${boundText(result.result, 900)}\n${result.threadId ? "詳細:" + reference(result.threadId) : ""}`,
    minutes: (revision, minutes) =>
      `📝 ${bold(`議事録・共有コンテキスト（rev ${revision}）`)}\n${boundText(minutes, 1750)}\n${contextHelp}`,
    replyContext: (context, text) => `↩️ ${bold(context)}\n${text}`,
    liveStatus: (notices) =>
      notices.length ? `\n${italic(`状態: ${notices.join(" / ")}`)}` : "",
  };
}
export const plainPresentation = createPresentation();
