# IDO Dashboard Plugin

Bundled with IDO Engine and started by default in a separate process. Requires Node.js 24.x. The administration UI is available through Engine at `/dashboard/`.

The React/Mantine UI shows engine-wide task routing, users and connections, project membership, and bounded raw data. It calls admin-only Engine APIs for snapshots, task stops and temporary disconnection. No provider credentials are stored in the browser. Legacy workspace APIs continue to use protocol-2 IPC for compatibility; the Client retains conversation and creation workflows.

Use Engine administration at `/admin` to stop or restart Dashboard. Administration, Discord and Client execution remain available when it is stopped. The browser fetches current Engine state after restart.

## 管理ダッシュボード

`/dashboard/` は管理者向けのタスク・割当・接続・プロジェクトの一覧です。
会話やタスクの追加はClientから行います。停止と一時切断、集計の定義、APIについては
[管理ダッシュボードのガイド](../../docs/ido-dashboard.md)を参照してください。
