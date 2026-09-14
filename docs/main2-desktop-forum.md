# main2: IDO AgentとDiscord issueフォーラム

main2の `ef27270` を起点に、`0ffdb98` までの更新を統合しています。9月13日にmainへ入ったPR #26 (`428cb01`) のデスクトップUI・終了制御・配布動線と、PR #7 (`17a9d98`) のフォーラム連携を、現在のEngine / Client / Plugin protocol 2へ適合させています。共通コードは `@ido/common` / `@ido/common-ui` の公開exportsを利用します。

## 今回の範囲

- Electron製IDO Agentに現在のClientを内蔵。実行一覧・詳細・承認・停止・プレビュー登録、フォルダー選択、アプリ名・バージョン・PIDを表示します。
- WindowsはNSIS、MacはApple Silicon / Intel別のDMGとZIPを作ります。Nodeと対象OSのCodexバイナリを内蔵します。Gitと取得済みのリポジトリは各PCで用意します。
- EngineタスクとDiscordフォーラムのスレッドを対応付け、状態・割り当てClient・実行版を更新します。追加指示・停止は既存Engineの権限判定とWorkPortへ渡します。
- `/ido connect` が本人だけにインストール案内を返します。案内ページから `ido-agent://connect?engine=...` を開くと接続先を入力します。

旧Gateway・独自の参加トークン配布・旧音声タスク割り振り・全承認による権限拡張・GitHub Issue自動作成は移植しません。通常のCodex Appで動く別タスクの取り込みも今回の対象外です。`v0` を実行時に参照しません。

## 参加者の手順

現在のタスク画面は一覧・状態・最終結果の確認が中心です。実行中の進捗は直近のイベント名であり、途中の説明、コマンドと出力、ファイル変更を時系列で保存・表示するアクティビティ画面は未実装です。

1. Discordで `/ido connect` を実行し、案内リンクを開きます。
2. 自分のOSのアプリをダウンロードします。WindowsはSetupを実行、MacはDMGのIDO AgentをApplicationsへ移動します。
3. 「IDO Agentを開いて接続先を入力」を押します。開かない場合はアプリを起動して、案内のEngine URLを貼り付けます。
4. アプリの「公式ログインを開始」でブラウザーのOpenAIログインを完了します。ログイン情報はClient専用領域に保存し、Botや他の参加者に渡しません。
5. 「接続の確認へ」からEngineへログインし、端末の確認値を照合して承認します。Engineアカウントは管理者が作成します。OpenAIアカウントとEngineアカウントは別です。
6. プロジェクトとGitフォルダーを対応付け、通信権限・同時実行数を確認して実行を許可します。
7. Discordの通常チャンネルで `!ido task 実装内容` を送ります。音声経由のタスク作成条件はmain2の会話担当の仕様に従います。
8. issueスレッドの通常メッセージは追加指示になります。`停止` / `中止` / `キャンセル` / `stop` / `cancel` の単独メッセージで停止を依頼できます。終了済みタスクの再試行はmain2のDashboardのタスク操作を使います。

リンクを開くだけでは接続承認や作業許可は行いません。実行中・接続済みのアプリを別Engineへ切り替えるリンクは拒否します。終了時はClientが所有する実行を停止してからウィンドウを閉じます。再起動時に以前の実行を勝手に再実行しません。

## 管理者の設定

EngineのDiscordプラグイン設定で、既存のGuild・テキストチャンネル・会議・プロジェクトに加えて次を設定します。

| 設定                  | 内容                                               |
| --------------------- | -------------------------------------------------- |
| `issueForumChannelId` | 同じGuildのissueフォーラムID。空欄なら同期しません |
| `windowsDownloadUrl`  | 公開したWindows SetupのHTTPS URL                   |
| `macArmDownloadUrl`   | 公開したMac Apple Silicon DMGのHTTPS URL           |
| `macIntelDownloadUrl` | 公開したMac Intel DMGのHTTPS URL                   |

フォーラムの閲覧者にはタスク概要・状態・Client IDが見えます。共有してよいメンバーだけが閲覧できるDiscord権限を設定してください。BotにはView Channel / Send Messages（フォーラム投稿作成）/ Send Messages in Threads / Read Message Historyを付与し、Message Content Intentを有効にします。必須タグを設定したフォーラムは避けてください。チャンネルの自動作成や権限変更は行いません。

タスク同期は10秒周期。再起動時にもEngineの現状を取得します。Bot自身・Webhookの投稿、別Guild・別フォーラム・未登録スレッドの投稿はタスク操作として受け付けません。Discordの許可ユーザー設定とEngine側のメンバー権限の両方が適用されます。

配布URLが空欄のOSは「配布準備中」と表示します。Releaseを実際に公開してから、その配布物のURLを設定してください。この変更はRelease公開やBot起動を自動では行いません。HTTPS接続先にはEngineで設定した公開originを使用します。参加者向けにlocalhostのURLを配らないようにしてください。

## ビルドと配布

```sh
npm ci
npm run build:desktop
npm run start:desktop
npm run smoke:desktop
# WindowsでWindows用を作成
npm run pack:desktop -- --win --x64
# Apple Silicon MacでApple Silicon用を作成
npm run pack:desktop -- --mac --arm64
# Intel MacでIntel用を作成
npm run pack:desktop -- --mac --x64
```

生成先は `dist/desktop`。対象OS・CPU上でビルドし、内蔵CodexのCPUとインストーラーのCPUを一致させます。GitHub ActionsのDesktop installersは3環境で配布物を生成し、Artifactとして保存します。PRでは外部にRelease公開しません。

開発ビルドは未署名です。一般配布にはWindowsのコード署名、MacのDeveloper ID署名・notarizationが必要です。配布担当が証明書を保護されたCI環境で設定し、electron-builderの署名設定を使用してください。秘密情報を設定ファイルに書きません。Macの実機起動とGatekeeper確認はMac上で行います。Windowsでのビルド成功はMac実機検証の代わりにはなりません。

自動アップデートは含めません。終了して新版を上書きインストールします。main2のClientデータ領域（Windows: LocalAppData内のido/client、Mac: Library/Application Support内のido/client）を維持します。旧v0アプリの認証・接続設定は自動移行しません。CLI Clientとの同時起動は同じロックで拒否します。

## 同期エラーと境界

Discordのスレッド作成要求は冪等ではないため、送信前に作成意図を永続化します。応答が不明なときはBotが作成したタスクマーカー付きスレッドを探し、再利用します。検索はアクティブと直近100件のアーカイブに限定し、見つからなくても重複作成しません。`forum-sync-error` の場合はBot権限・フォーラム種別・必須タグを確認し、該当スレッドを削除・改名せず管理者が対応を確認してください。1件の失敗で他タスクの同期は停止しません。

ローカルUIはloopbackだけにbindし、既存Host/Origin/CSRF検証を維持します。Electron rendererはNode APIを持たず、context isolationとsandboxを有効にします。IPCはフォルダー選択だけで、呼び出し元のウィンドウ・メインフレーム・originを検証します。外部ブラウザーで開けるのは現在の公式ログインURLと端末承認URLだけです。タスクのログ・差分・認証情報はフォーラムへ投稿しません。

参考: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security)、[macOS notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)、[公式Codex認証](https://learn.chatgpt.com/docs/auth)。
