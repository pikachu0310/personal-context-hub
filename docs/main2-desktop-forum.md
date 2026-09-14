# main2: IDO AgentとDiscord issueフォーラム

main2の `ef27270` を起点に、`0ffdb98` までの更新を統合しています。9月13日にmainへ入ったPR #26 (`428cb01`) のデスクトップUI・終了制御・配布動線と、PR #7 (`17a9d98`) のフォーラム連携を、現在のEngine / Client / Plugin protocol 2へ適合させています。共通コードは `@ido/common` / `@ido/common-ui` の公開exportsを利用します。

## 今回の範囲

- Electron製IDO Agentに現在のClientを内蔵。実行一覧・詳細・承認・停止・プレビュー登録、フォルダー選択、アプリ名・バージョン・PIDを表示します。
- WindowsはNSIS、MacはApple Silicon / Intel別のDMGとZIPを作ります。Nodeと対象OSのCodexバイナリを内蔵します。Gitと取得済みのリポジトリは各PCで用意します。
- EngineタスクとDiscordフォーラムのスレッドを対応付け、状態・割り当てClient・実行版を更新します。追加指示・停止は既存Engineの権限判定とWorkPortへ渡します。
- `/ido connect` が本人だけにインストール案内を返します。案内ページから `ido-agent://connect?engine=...` を開くと接続先を入力します。

旧Gateway・独自の参加トークン配布・旧音声タスク割り振り・全承認による権限拡張・GitHub Issue自動作成は移植しません。通常のCodex Appで動く別タスクの取り込みも今回の対象外です。`v0` を実行時に参照しません。

## 参加者の手順

Issueに対応するタスク一覧は「このPC」「ほかのPC」「未割り当て」に分けて表示します。このPCへの割り当て後、まだ実行データが届いていないタスクは「このPC · 受け取り待ち」に表示します。判定にはログイン名ではなくEngineの割り当て端末IDを使うため、同じ利用者の別PCも区別できます。

ほかのPCのタスクは担当者・端末名・接続状態・共有進捗を表示します。追加指示・停止はDiscordの対応スレッドから操作します。共有一覧には認証済みClientの接続を使い、Dashboardと同じチームのタスク閲覧範囲を適用します。ローカルのコマンド出力、作業パス、承認情報は共有一覧に含めません。接続中かつアプリ表示中に約2.5秒間隔で取得し、15秒以上更新がなければ古い情報として表示、切断時には破棄します。進行中を優先して最大200件を取得し、省略時には件数を表示します。

この一覧には更新後のEngineとClientの両方が必要です。旧Engineの場合も、このPCのタスク表示と操作は利用できます。

タスク画面は左にプロジェクト別の一覧、中央に依頼・作業メモ・コマンド・変更ファイル・結果を時系列で表示します。コマンドを開くと出力と終了コードを確認できます。画面下部から追加指示を送り、停止できます。「変更を確認」は作業フォルダーの現在の未コミット差分を表示します。

1. Discordで `/ido connect` を実行し、案内リンクを開きます。
2. 自分のOSのアプリをダウンロードします。WindowsはSetupを実行、MacはDMGのIDO AgentをApplicationsへ移動します。
3. 「IDO Agentを開いて接続先を入力」を押します。開かない場合はアプリを起動して、案内のEngine URLを貼り付けます。
4. アプリの「公式ログインを開始」でブラウザーのOpenAIログインを完了します。ログイン情報はClient専用領域に保存し、Botや他の参加者に渡しません。
5. 「接続の確認へ」からEngineへログインし、端末の確認値を照合して承認します。Engineアカウントは管理者が作成します。OpenAIアカウントとEngineアカウントは別です。
6. プロジェクトとGitフォルダーを対応付け、通信権限・同時実行数を確認して実行を許可します。
7. Discordの通常チャンネルで `!ido task 実装内容` を送ります。音声経由のタスク作成条件はmain2の会話担当の仕様に従います。
8. issueスレッドの通常メッセージは追加指示になります。`停止` / `中止` / `キャンセル` / `stop` / `cancel` の単独メッセージで停止を依頼できます。終了済みタスクの再試行はmain2のDashboardのタスク操作を使います。

リンクを開くだけでは接続承認や作業許可は行いません。実行中・接続済みのアプリを別Engineへ切り替えるリンクは拒否します。終了時はClientが所有する実行を停止してからウィンドウを閉じます。再起動時に以前の実行を勝手に再実行しません。

## Auto / Manualと作業中の会話

接続設定の「新しいタスクの進め方」で選択します。設定は次に受け取るタスクへ適用し、既存タスクの進行途中でモードを置き換えません。

- **Auto**: 受け取った依頼に沿って作業を進めます。
- **Manual · 会話する**: Codexの計画モードで相談し、計画を提示したら待機します。入力欄で相談を続け、「実行する」を押したときに同じセッションで実装へ移ります。
- 作業中は両モードで追加指示を送れます。進行中のターンへ届け、反映済み・待機・配送不明を会話ログに表示します。ターン終了に間に合わなかった指示は自動で新しい実行を始めず、明示的な再実行を待ちます。

進め方は実行権限と別です。Manualから実行へ移る際も元のsandbox・通信制限・追加権限の承認を維持します。計画モードは会話と作業の進め方であり、サンドボックスの代替ではありません。停止・アプリ終了・再起動後は自動で作業を再開しません。新規依頼と終了済みタスクの再実行はDiscord / Dashboardから行います。

アプリからの追加指示は、認証済みの既存Client接続でEngineへ送り、端末の所有タスク・実行版・現在のメンバー権限を確認したうえでWorkPortに渡します。受付IDを再利用して二重配送を防ぎ、応答が不明な場合は自動再送しません。旧Engine接続時には入力を無効にします。

行動ログはClient専用領域の既存`runs.json`内に保持します。1タスクにつき最大300項目、JSONで約256,000文字、各テキスト欄16,000文字の上限を設け、省略がある場合は画面に示します。認識可能な認証情報はマスクしますが、公開用ログではありません。ツールの生の引数・結果や内部の推論は記録しません。各項目の開始・更新・完了通知を記録し、コマンド出力は完了通知で確定します。変更前の古いタスクの詳細ログは復元しません。

ログ全文はEngine / Discordへ送らず、選択したタスクのログだけをローカルUIへ取得します。既存の結果・状態同期は維持します。APIはloopbackのHost / Originチェックと書き込みのCSRFチェックを通します。

参考: [公式Codex App Server仕様](https://learn.chatgpt.com/docs/app-server)。`turn/start`のcollaborationModeで計画と実行を切り替え、`turn/steer`で進行中の追加指示を配送します。

`npm run smoke:workspace`は合成Codex応答と一時的なClientで会話・計画実行・追加指示・差分・停止・狭い画面を検証します。外部アカウント・Discord・モデルを使用しません。実アカウントでのログインと実タスク、Mac実機は別途検証が必要です。

## 管理者の接続設定

### アプリからのローカル実験

ローカルタスクの「エージェント」でCodex / Claude Codeを選択できます。Claudeは公式Agent SDKのランタイムを内蔵し、各PCの公式Claude Code認証を利用します。「接続とセットアップ」のClaudeログイン・認証確認を使用してください。認証情報をアプリ独自のストアやEngineへコピーしません。今回のClaude選択はローカルタスクだけで、Engineから届くタスクは引き続きCodexを使います。

Claudeの実行・セッション継続・ログ変換はClientの `agents/` に分離しています。Manualではファイル変更・シェルを無効にして計画を返し、アプリの「実行する」で作業に移ります。実行中の追加指示は、現在の処理が終わった後に同じClaudeセッションで続行します。会話・ツール・変更ファイルを共通の行動ログに表示し、内部のthinkingやファイル読み取りの生の結果は記録しません。将来用のローカル進捗概要にもagent種別を含めます。

ClaudeはCodexのOSサンドボックスと同一ではありません。アプリでは明示的な権限説明への同意を必要とし、Read / Glob / Grep / Write / Edit / Bash以外のツール、プロジェクト設定・MCP・プラグインの自動読込を使いません。ファイル操作はworktree内の実パスを確認して操作ごとに承認します。読み取り専用・Manualの計画中・通信禁止時にはBashを提供しません。Bashを使える場合も必ず承認を要求しますが、承認されたシェルはOS全体に影響し得ます。Windowsでシェルを使うにはClaude Codeが要求するGit Bash環境も必要です。

ローカルタスク作成画面では、公式CLIでログイン状態を確認できたエージェントだけを表示します。Codexは専用Codexの `model/list`、ClaudeはSDKの `supportedModels()` から一覧を取得します。Claudeの一覧取得は制御チャネルの初期化だけで、ユーザープロンプトやタスクを送信しません。固定候補・既定モデル・モデルIDの手入力は表示しません。取得に失敗した場合は開始を無効にし、「接続とセットアップ」でのログインと再確認を案内します。画面表示・再フォーカス・60秒周期・更新ボタンで再確認し、タスク開始時にもログイン状態とモデル一覧を取得して照合します。ログイン確認はCLIの認証状態に基づき、提供元の利用枠・一時的障害まで保証するものではありません。

選択はエージェントごとにフォーム内で保持し、タスク開始時に保存します。同じタスクの相談・実行・追加指示・セッション再開でも引き継ぎ、タスク画面にも表示します。実行中のモデル変更は含みません。指定モデルが利用できない場合に別モデルへ自動変更しません。

参照: [Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Claudeのモデル設定](https://code.claude.com/docs/en/model-config)、[公式Agent SDKの権限仕様](https://code.claude.com/docs/en/agent-sdk/permissions)、[公式Claude Codeの認証](https://code.claude.com/docs/en/authentication)。SDKを利用した合成応答テストとWindowsアプリ起動は検証対象ですが、実アカウントのログイン・課金を伴うモデル実行、Mac実機は別途確認します。

左メニューの「新しいローカルタスク」から、Gitリポジトリ・依頼内容・Auto/Manual・実行権限・通信許可を指定して開始できます。Codexのログインは「接続とセットアップ」で事前に済ませます。Engineへの接続やリモートタスクの受け取り許可は不要です。

選んだリポジトリのHEADからClient専用worktreeを作り、元の未コミット変更はコピーしません。Autoは作業開始、Manualは相談・計画後に「実行する」で開始します。作業中の追加指示・承認・停止はアプリで行えます。同時実行枠はこのPCのリモートタスクと共有します。タスクと行動ログは保存し、アプリ再起動後は中断状態として表示します。自動再開はしません。終了・中断した実験の再試行は、新しいローカルタスクとして依頼してください。

ローカル由来のタスクには「Bot未共有」と表示します。Engine向けの結果・ACK・プレビュー登録には流さず、Engineからのコマンドでローカルタスクを操作できないように実行元を区別します。今回のローカル開始機能ではEngine・Botのルーティングは変更しません。

後続のBot連携用に、Client内の `localProgress()` と読み取り専用 `GET /api/local-tasks/progress` を用意しています。`schemaVersion: 1`、`sharing: "not-connected"` と、各タスクのID・実行版・状態・進行段階・タイトル・短い進捗・更新時刻・`changeToken`を返します。`changeToken`は概要の内容ハッシュで、状態だけが変わった場合も検出できます。命令本文・ローカルパス専用フィールド・コマンド出力・承認・認証情報・最終結果は含めません。ただしタイトルと進捗は利用者の内容を含むため、将来の外部転送前に共有範囲の設定が必要です。

このAPIは既存のloopback Host/Origin制限内だけで使用します。外部公開・Botへの自動転送・配送確認・再送はまだ実装していません。後続の連携は、この概要を読み取るアダプターを追加し、ローカル実行処理とは分離します。

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
