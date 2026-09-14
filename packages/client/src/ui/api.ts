import { browserApi } from "@ido/common/runtime/browser-api";
const request = browserApi("/api/");
const errors: Record<string, string> = {
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
    throw new Error(
      errors[(error as Error).message] ?? (error as Error).message,
    );
  }
}
