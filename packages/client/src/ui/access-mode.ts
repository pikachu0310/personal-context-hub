import type { AccessMode } from "@ido/common/contracts/work";

export const accessOptions: { value: AccessMode; label: string }[] = [
  { value: "sandbox", label: "サンドボックス内で実行" },
  { value: "approval", label: "許可を求める" },
  { value: "full", label: "フルアクセス" },
];

export const accessHelp = {
  sandbox:
    "作業フォルダー内のサンドボックスで実行します。通信は保存済みの通信設定に従います。追加の権限要求は画面で承認します。",
  approval:
    "OSサンドボックスは無効です。ファイル操作・通信が可能で、権限が必要な操作では承認を求めます。",
  full: "OSサンドボックスと操作の承認を無効にします。PCのファイル操作・通信が可能です。",
};

export const projectAccessHelp =
  "このPCのプロジェクト既定値です。変更後に新しく受け取るタスクへ適用します。既存タスクは変更せず、受信タスクの明示的な制限は優先します。";
