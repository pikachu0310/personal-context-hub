# IDO Agentのビルドと配布

Electronのウィンドウから既存のWorker・Codex実行系を管理します。Windows x64向けのNSISインストーラーを生成します。配布対象は参加者用クライアントです。Bot本体・Bot設定・秘密情報は同梱しません。

## 開発・検証

WindowsネイティブのNode.js 22以降とGitを使用します。

```powershell
npm ci
npm run agent:desktop
npm run agent:desktop:package
npm run agent:desktop:smoke
```

成果物は `dist/desktop/IDO-Agent-Setup-0.2.0.exe` と `dist/desktop/win-unpacked/` です。スモークテストは隔離した設定ディレクトリで配布版を起動し、ウィンドウ・IPC制限・未認証HTTPの拒否・終了時のローカルサーバー停止を確認します。Botへの接続やOpenAIへのログイン・有料タスク実行は行いません。

`scripts/prepare-agent-desktop.mjs` は検証済みのステージング先を消去し、クライアント依存のソースだけをコピーします。Codex SDKとWebSocketのバージョンはルートのlockfileに固定します。公式Codex実行ファイルを同梱するため、実ファイルパスを維持する `asar: false` を使用します。アイコンは `desktop/icon.svg` から `node scripts/build-agent-icon.mjs` で再生成できます。

## プロセスと信頼境界

- メインプロセスがWorker・ローカルAPI・ログイン子プロセスを管理します。通常の終了はタスクのAbort完了を待ちます。OSの強制終了・電源断までの後始末は保証しません。
- レンダラーはsandbox・contextIsolationを有効にし、Node.jsアクセスを無効にします。IPCは送信ウィンドウ・トップフレーム・URL・ルートと入力サイズを確認します。外部ページはOpenAI認証とGitの公式HTTPSだけをシステムブラウザで開きます。
- ローカルAPIはloopbackのランダムポートです。操作キーはメインプロセスだけで保持し、レンダラーのURLへ渡しません。外部公開する機能はありません。
- 外部Codexタスク表示は起動ごとに無効です。有効にした場合だけ通常の `CODEX_HOME` またはホームディレクトリの `.codex` にあるローカルSQLiteのメタデータを読み取ります。会話本文・rollout・認証ファイルは読まず、タスク名と作業場所はIPCだけで表示します。直近7日・最大30件、更新間隔10秒です。内部スキーマが非対応なら利用不可と表示します。実行状態の取得・他のCodexの停止は行いません。
- このアプリのタスク履歴は最大60件をメモリー内に保持し、各タスクの進捗は直近30件です。作業結果のファイルとCodex自身の実行データは端末に残ります。

## 配布

この設定だけで生成したインストーラーは **未署名** です。一般配布に向けては発行者のコード署名を構成し、実際のWindows端末で署名・インストール・アンインストールを検証してください。検査を回避する案内はしません。自動更新・ログイン時の自動起動・トレイ常駐は実装していません。

レビュー済みインストーラーを公開した後、Botのローカル設定 `PERSONAL_CONTEXT_VOICE_AGENT_DOWNLOAD_URL` にHTTPS URLを指定すると、Discordのセットアップ案内にダウンロードボタンが出ます。URLには参加コード・認証情報を含めないでください。URL未設定時は主催者からインストーラーを受け取る案内になります。リリース公開やBotの起動はビルドコマンドから行いません。

従来の `Start Agent.cmd` とブラウザUIは開発・移行用に残しています。通常の参加案内では配布しません。旧ブラウザUIのタブを閉じても旧プロセスは止まらないため、切り替え前に旧UIの接続停止と起動プロセスの終了を行います。

参考: [Electronのセキュリティガイド](https://www.electronjs.org/docs/latest/tutorial/security)、[electron-builderのNSIS設定](https://www.electron.build/nsis/)、[Codex App Server](https://developers.openai.com/codex/app-server/)。App Serverのロード状態はそのサーバーが管理するスレッドの状態であり、新しいサーバーを起動するだけで他プロセスの実行状態を取得できるとは扱いません。
