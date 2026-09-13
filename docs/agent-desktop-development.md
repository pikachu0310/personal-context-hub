# IDO Agentのビルドと配布

Electronのウィンドウから既存のWorker・Codex実行系を管理します。Windows x64向けのNSISインストーラーを生成します。配布対象は参加者用クライアントです。Bot本体・Bot設定・秘密情報は同梱しません。

## 開発・検証

WindowsネイティブのNode.js 22以降とGitを使用します。

```powershell
npm ci
npm run agent:desktop:package
npm run agent:desktop:smoke
```

成果物は `dist/desktop/IDO-Agent-Setup-0.2.2.exe` と `dist/desktop/win-unpacked/` です。スモークテストは隔離した設定ディレクトリで配布版を起動し、ウィンドウ・IPC制限・未認証HTTPの拒否・終了時のローカルサーバー停止を確認します。Botへの接続やOpenAIへのログイン・有料タスク実行は行いません。

ビルド後の手動確認は `dist/desktop/win-unpacked/IDO Agent.exe` を開きます。リポジトリ直下の `Start Agent.cmd` もこの実行ファイルを優先して起動し、なければインストール済みのスタートメニューのショートカットを開きます。見つからない場合は手順を表示し、インストールや別プロセスの起動を自動では行いません。

ソース変更をその場で確認する開発起動には `npm run agent:desktop` を使います。ビルド済みアプリには変更が自動反映されないので、配布前に再ビルドしてください。WindowsのチェックアウトではWindowsのNode.js/npmを使用し、WSLのnpmからWindows版アプリを起動しないでください。

`scripts/prepare-agent-desktop.mjs` は検証済みのステージング先を消去し、クライアント依存のソースだけをコピーします。Codex SDKとWebSocketのバージョンはルートのlockfileに固定します。公式Codex実行ファイルを同梱するため、実ファイルパスを維持する `asar: false` を使用します。アイコンは `desktop/icon.svg` から `node scripts/build-agent-icon.mjs` で再生成できます。

## プロセスと信頼境界

- メインプロセスがWorker・ローカルAPI・ログイン子プロセスを管理します。通常の終了はタスクのAbort完了を待ちます。OSの強制終了・電源断までの後始末は保証しません。
- レンダラーはsandbox・contextIsolationを有効にし、Node.jsアクセスを無効にします。IPCは送信ウィンドウ・トップフレーム・URL・ルートと入力サイズを確認します。外部ページはOpenAI認証とGitの公式HTTPSだけをシステムブラウザで開きます。
- ローカルAPIはloopbackのランダムポートです。操作キーはメインプロセスだけで保持し、レンダラーのURLへ渡しません。外部公開する機能はありません。
- 外部Codexタスク表示は起動ごとに無効です。有効にした場合だけ通常の `CODEX_HOME` またはホームディレクトリの `.codex` にあるローカルSQLiteのメタデータを読み取ります。会話本文・rollout・認証ファイルは読まず、タスク名と作業場所はIPCだけで表示します。直近7日・最大30件、更新間隔10秒です。内部スキーマが非対応なら利用不可と表示します。実行状態の取得・他のCodexの停止は行いません。
- このアプリのタスク履歴は最大60件をメモリー内に保持し、各タスクの進捗は直近30件です。作業結果のファイルとCodex自身の実行データは端末に残ります。

## 配布

主催者のPCから直接配布する場合は、Botのローカル設定 `PERSONAL_CONTEXT_VOICE_AGENT_INSTALLER_PATH` に検証済みインストーラーの絶対パスを指定します。Worker Gatewayが同じHTTPポートの `/agent` にインストールガイド、`/agent/installer.exe` に指定ファイルだけを公開します。公開WSSが設定されていれば、未設定のガイド・ダウンロードURLをその接続先から自動生成し、Discordの案内に使用します。明示したHTTPS URLは優先します。

ファイルは通常の `.exe`、最大350 MiBに限定し、起動時に読み込んだ内容を配布します。ディレクトリ一覧や他のファイルは公開しません。Botまたはトンネルを停止すると配布リンクも使えなくなります。一時トンネルのURLが変わった場合は、Botの公開WSS設定を更新して再起動してください。参加者アプリのローカルAPIは公開しません。

デスクトップの対話実行にはCodex App Serverを使い、コマンド・ファイル操作と `item/permissions/requestApproval` の承認をローカルIPC経由で返します。既定は個別承認で、期限切れ・停止・終了では拒否します。全承認は接続画面または一時停止後に端末所有者が明示した場合だけ有効です。要求された権限だけを返し、権限付与のscopeはturnです。未知の要求や認証フローを自動承認しません。Windowsの初回設定は `windowsSandbox/setupStart` による管理者確認付きセットアップです。

この設定だけで生成したインストーラーは **未署名** です。一般配布に向けては発行者のコード署名を構成し、実際のWindows端末で署名・インストール・アンインストールを検証してください。検査を回避する案内はしません。自動更新・ログイン時の自動起動・トレイ常駐は実装していません。

レビュー済みインストーラーを公開した後、Botのローカル設定 `PERSONAL_CONTEXT_VOICE_AGENT_DOWNLOAD_URL` にHTTPS URLを指定すると、Discordのセットアップ案内にダウンロードボタンが出ます。URLには参加コード・認証情報を含めないでください。URL未設定時は主催者からインストーラーを受け取る案内になります。リリース公開やBotの起動はビルドコマンドから行いません。

`Start Agent.cmd` はデスクトップアプリの起動用です。参加者にはインストーラーを配布し、スタートメニューからの起動を案内してください。旧ブラウザUIは移行時の診断用に `npm run agent:ui` で起動できます。旧UIのタブを閉じても旧プロセスは止まらないため、切り替え前に旧UIの接続停止と起動プロセスの終了を行います。

## 主催者の反映・起動手順

1. Windowsでインストーラーをビルド・検証します。テスト参加者へファイルを渡すか、レビュー済みの配布先へ公開します。未署名のテスト版である場合は、その状態を伝えてください。
2. 公開した場合だけ、Botが実際に読み込むローカル設定に `PERSONAL_CONTEXT_VOICE_AGENT_DOWNLOAD_URL` を指定します。参加ガイドのURLは `PERSONAL_CONTEXT_VOICE_AGENT_JOIN_GUIDE_URL` です。ローカルファイルパスやlocalhostをダウンロードURLとして設定しないでください。URLを設定しない場合は、主催者からインストーラーを受け取る案内が表示されます。
3. Bot側にもこの版のコードを反映し、Worker Gatewayと公開WSS接続先を用意してから、Botの環境で `npm ci`、`npm run start:discord:voice` を実行します。WSLで運用しているBotは、WSL側のチェックアウトと設定を使います。この操作は実際にDiscordへ接続します。
4. Discordで `/ido agent setup` の案内と配布先、`/ido agent connect` の参加情報を確認します。参加者はWindowsアプリで接続し、`/ido task` でテスト依頼を送って承認・進捗・停止を確認します。

ドキュメントの変更だけでは稼働中Botの案内は変わりません。Botへのコード反映と再起動が必要です。インストーラーの作成だけで、公開配布先・WSS接続先・Botの起動が完了するわけではありません。

参考: [Electronのセキュリティガイド](https://www.electronjs.org/docs/latest/tutorial/security)、[electron-builderのNSIS設定](https://www.electron.build/nsis/)、[Codex App Server](https://developers.openai.com/codex/app-server/)。App Serverのロード状態はそのサーバーが管理するスレッドの状態であり、新しいサーバーを起動するだけで他プロセスの実行状態を取得できるとは扱いません。
