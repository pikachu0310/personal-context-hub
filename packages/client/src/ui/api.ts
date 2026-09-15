import { lifecycleError } from "@ido/common-ui";
import { browserApi } from "@ido/common/runtime/browser-api";
const request = browserApi("/api/");
const errors: Record<string, string> = {
  MEETING_INPUT_UNSUPPORTED: "ブラウザから発言するにはEngineの更新が必要です。",
  UNKNOWN_OPERATION:
    "接続先Engineがこの操作に対応していません。Engineを更新してください。",
  MEETING_INPUT_BUSY:
    "先ほどの発言を処理しています。少し待ってからお送りください。",
  INVALID_MEETING_AUDIO:
    "音声を読み込めませんでした。12秒以内で録音し直してください。",
  MEETING_INPUT_REQUIRED: "会議へ送る文章か音声が必要です。",
  TASK_OPTIONS_UNSUPPORTED:
    "依頼のモデルと進め方を引き継ぐにはEngineの更新が必要です。",
  STOP_BEFORE_ACCESS_CHANGE:
    "実行停止を確認してから権限を変更してください。変更後に追加指示で同じタスクを再開できます。",
  CLAUDE_SANDBOX_UNSUPPORTED:
    "ClaudeではOSサンドボックスを利用できません。Codexを選ぶか、実行権限を変更してください。",
  INVALID_ACCESS_MODE: "実行権限を選び直してください。",
  MINUTES_CONFLICT:
    "議事録が更新されました。入力を保持しています。最新版を確認して再度保存してください。",
  INVALID_MINUTES: "議事録は100,000文字以内で入力してください。",
  MEETING_NOT_FOUND:
    "議事録は削除されたか、このプロジェクトから参照できません。",
  SOURCE_LIMIT_EXCEEDED: "ソースは20件、合計64,000文字まで追加できます。",
  INVALID_AVATAR:
    "画像を読み込めません。別のPNG・JPEG・WebP画像を選択してください。",
  PAIRING_REQUIRED: "先にチームのEngineへの接続を設定してください。",
  CONTINUATION_UNSUPPORTED:
    "Engineを更新すると、このタスクの続きを依頼できます。",
  TASK_STILL_ACTIVE:
    "タスクがすでに再開されています。最新の状態を確認してください。",
  TASK_CONTROL_SUPERSEDED:
    "タスクの実行版が変わっています。最新の状態を確認してください。",
  INSTRUCTION_DELIVERY_UNCERTAIN:
    "前の指示の実行結果が未確認です。先にその指示を確認してください。",
  TASK_NOT_ASSIGNED:
    "元の実行先がないため再開できません。新しいタスクとして依頼してください。",

  PROJECT_DIRECTORY_REQUIRED:
    "先にこのプロジェクトの保存先を設定してください。",
  PROJECT_OWNER_REQUIRED: "この操作はプロジェクトオーナーだけが行えます。",
  PROJECT_INVITATION_REQUIRED:
    "このプロジェクトには参加していません。オーナーから招待を受けてください。",
  INVITATION_ENGINE_MISMATCH: "招待元のEngineへClientを接続してください。",
  INVITATION_EXPIRED:
    "招待の有効期限が切れています。新しい招待を受けてください。",
  NEW_INVITATION_REQUIRED: "オーナーから新しい招待を受けてください。",
  PROJECT_DIRECTORY_REQUIRES_EMPTY_OR_COMMITTED_REPO:
    "コミット済みGitリポジトリ、または空フォルダを選択してください。既存ファイルは自動コミットしません。",
  PROJECT_NAME_EXISTS:
    "同名プロジェクトがあります。既存プロジェクトのメニューから「接続・設定」を開き、保存先を設定してください。",
  PROJECT_DELIVERY_UNKNOWN:
    "作成結果を確認できません。同じ名前・ディレクトリでもう一度追加すると、同じ要求を確認します。",
  FINISH_PENDING_PROJECT_FIRST:
    "前回の作成結果が未確認です。前回と同じ名前・ディレクトリで再試行してください。",
  PROJECT_CONNECTION_REQUIRED: "承認済みのClientをEngineへ接続してください。",
  PAUSE_BEFORE_EDITING:
    "実行を一時停止し、実行中のタスクが終了してから保存先を変更してください。",
  PERMISSION_DENIED: "現在のアカウントには操作権限がありません。",
};
export async function api<T>(
  path: string,
  input?: Record<string, unknown>,
): Promise<T> {
  try {
    return await request<T>(path, input);
  } catch (error) {
    throw new Error(errors[(error as Error).message] ?? lifecycleError(error));
  }
}
