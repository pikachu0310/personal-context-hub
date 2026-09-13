# ローカルエージェントの公開接続を運用する

この構成は、参加を許可した開発者が自分のPCで作業するためのものです。不特定多数へ無制限のコード実行を提供するサービスではありません。参加案内を公開することと、タスク実行権限を誰にでも渡すことは分けて扱います。

## 公開するもの

公開するのは中央BotのWorker GatewayのWSS接続先と、秘密を含まない参加ガイドだけです。参加者のローカルUI、OpenAI認証のコールバック、Codex App Server、ファイルシステム、Botの資格情報は公開しません。Tailscaleや参加者側のVPNは不要です。

参加条件を満たす人には、Discordの本人だけに見える応答で `Connect-Agent.cmd` を配布します。稼働中のBotと同じ版の接続クライアントを同梱し、設定・認証情報・実行履歴は含めません。取得にGitHubへのログインは不要です。`WORKER_ALLOW_GUILD_MEMBERS=true` の場合、登録済みの参加者は本人のエージェントへのIssueタスク作成と停止ができます。`ALL_PARTICIPANTS_OPERATE=false` のまま利用でき、他人のタスクとBot全体の操作権限は付与しません。

## 主催者のPCで運用する

サーバーを借りず、主催者のPCでBotとWorker Gatewayを動かせます。各参加者のPCでは接続アプリとCodexを動かします。主催者のPCを停止・スリープすると、Botと参加者の接続も止まります。

離れたネットワークからの接続には、Cloudflare Tunnelを通信経路として使う構成を想定しています。トンネルは主催者のPCから外向きに接続し、ルーターの受信ポートを開けずにGatewayへ通信を転送します。PCからはDiscordやOpenAIにも通信します。外部サービスを一切使わずに完結する構成ではありません。[Cloudflare Tunnelの仕組み](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)

転送対象は主催者のPCの `127.0.0.1:8787` だけです。参加者用UIの `127.0.0.1:17879` やOpenAI認証のコールバックは転送しません。トンネル経由でも参加コード・端末鍵・所属確認・実行確認は必要です。WSSはCloudflareでTLSを終端するため、この構成ではCloudflareも通信経路として信頼する必要があります。OpenAIの認証情報は中継するメッセージに含めません。

テスト用のQuick Tunnelは無料ですが、URLは起動時に発行され、稼働保証もありません。常用には正式なトンネルと固定の接続先を用意します。トンネルの準備が完了するまでは、外部PCから接続できるとは扱いません。[テスト用トンネルの条件](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)

参加者は既存の接続画面から参加します。GitHubログインをBot接続の前提にせず、会話や接続確認をGitHubのIssueコメント・コミットへ書き込む通信方式は使いません。GitHubはコード・Issue・PRの管理、Discord Forumは相談・進捗の表示に使います。

### 公開前の設定チェック

Windowsでは `Check Agent Host.cmd` をダブルクリックし、Botが実際に使用する `.env` をファイル選択画面で指定します。BotをWSLで動かす場合はWSL側の設定ファイルを選びます。診断はファイルを読み取るだけで、秘密の値・サーバーID・接続先の実名を表示しません。Botやトンネルの起動、外部通信、設定変更は行いません。Node.js 22以降が必要です。

CLIでは `npm run doctor:discord:agents -- --env-file <Botの.envのパス>` でも同じ検査ができます。この診断は接続に関係する設定だけを対象とします。公開WSSの設定が通っても、TLS・実際の転送先・外部PCからの到達性・Discordの所属・Codexのログインは検証済みになりません。接続先が未設定なら、その不足を独立して表示します。

接続先を `/workers` にする場合、Gatewayもそのパスだけを受け付けます。プロキシはパスを書き換えずに転送してください。クエリ、フラグメント、URL内の認証情報、符号化や正規化で別のパスに見えるURLは、参加情報・画面・Worker・Gatewayの共通ルールで拒否します。

## TLSリバースプロキシを用意する場合

Gatewayは `127.0.0.1:8787` にbindし、同じホストのTLSリバースプロキシから転送します。[Caddy設定例](../deploy/agent-gateway.Caddyfile.example)では公開先を `wss://agents.example.com/workers` とし、このパスだけを転送します。実際のドメインのDNSをホストへ向け、証明書取得のための接続条件を満たしてください。Caddyの[WebSocket転送](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)と[自動HTTPS](https://caddyserver.com/docs/automatic-https)を使います。

このファイルは配置例です。実サーバーのDNS・証明書・ファイアウォール・TLS終端での検証は別途必要です。127.0.0.1へのbindは、同じPCの別プロセスからのアクセスまで拒否するものではありません。

## 参加と失効

Bot全体の作業操作は `PERSONAL_CONTEXT_VOICE_USER_ID` の運営者と `PERSONAL_CONTEXT_VOICE_OPERATOR_IDS` の担当者に限定します。`ALL_PARTICIPANTS_OPERATE=false`、`AUTONOMOUS_TASKS=false`、ホストの `CODEX_SANDBOX=workspace-write` を維持してください。公開WSS設定時にはこれらを起動時に検証します。

本人のWorker登録は管理権限とは別です。`PERSONAL_CONTEXT_VOICE_WORKER_ALLOW_GUILD_MEMBERS=true` なら、このBotを設定したDiscordサーバーのメンバーが自分のWorkerを登録できます。参加者のID入力や運営者による個別登録は不要です。参加者のロールで絞る場合は `PERSONAL_CONTEXT_VOICE_WORKER_ENROLLMENT_ROLE_IDS` にロールIDをカンマ区切りで指定します。指定したうち1つ以上を持つ人だけを許可し、空なら全メンバーを対象にします。Botアカウントとメンバー審査が未完了の人は除外します。これらは本人のエージェント接続だけの設定であり、他人のWorkerやBot全体の操作権限を付与しません。

参加条件は `discord-agent-enrollment-policy.mjs` に集約し、Discordから取得した所属・ロールで評価します。判定結果のキャッシュは最大30秒で、登録・コード引き換え・再接続・受信メッセージ時に確認します。退会・ロール解除後は、再確認時に以前の接続鍵も拒否します。Discordへの確認失敗時は許可しません。`WORKER_ALLOW_GUILD_MEMBERS=false` に戻すと、従来の運営者・操作担当者だけの登録になります。

Discordの `/ido agent connect` は本人専用の応答に限って参加情報を表示します。参加情報には5分間・1回限りのコードを含むので、Forum・GitHub Issue・ログへ転載しないでください。参加ガイドのリンクにはコードやトークンを含めません。`PERSONAL_CONTEXT_VOICE_AGENT_JOIN_GUIDE_URL` には公開HTTPSガイドを設定します。

Workerは端末のEd25519秘密鍵と接続トークンで認証します。中央には公開鍵とトークンのハッシュを保存します。`/ido agent disconnect` で本人の登録を失効できます。運営者が許可リストから人を外して再起動した場合も、以前の接続鍵だけで再接続できないようにします。別サーバーで運用するときは、Botと状態ファイルを分けてください。

## ローカル実行の境界

Web画面では本人によるタスク確認を既定にし、確認前・拒否時・期限切れ・切断時にはタスクを実行しません。自動実行とタスクの外部通信は接続ごとの明示的な選択です。`workspace-write` のサンドボックスと分離worktreeを使い、タスクから実行設定を変更できないようにします。

worktreeはコード変更の分離であり、仮想マシンのような完全なOS隔離ではありません。指定するリポジトリと参加するチームを信頼できることが前提です。モデルには作業内容が送られ、Botには進捗と回答が送られます。モデルが生成する回答に秘密が混入しないことまでは保証できないため、共有してよいコードを置いた開発用のOSユーザーで運用してください。未知の参加者がいる場合は自動実行・外部通信を有効にせず、実行するタスクを本人が確認します。

GitHubへのpush・PR作成・mergeは各自のGitHub権限で行い、差分と投稿先を確認します。Forum上の質問や他エージェントの提案を、それだけで権限付与と扱いません。現在のIssue台帳はローカル状態であり、GitHub Issueとの双方向同期を実装済みとは扱わないでください。

## 負荷と公開前の確認

Gatewayは接続数200、未認証接続32、各接続のメッセージ120件/10秒、待機メッセージ16件を上限とし、未認証接続を30秒で閉じます。接続数超過はWebSocketへ切り替える前に拒否します。WebSocketメッセージは256 KiB、断片は64までで、圧縮は無効です。ブラウザOrigin、用途外のサブプロトコル、設定したパスと異なる要求も拒否します。転送ヘッダーを本人確認に使いません。

不正・過大なフレームはその接続を閉じ、Bot全体を停止させません。切断に応答しない相手は1秒で強制切断します。キャンセル済みのタスクは送らず、送信失敗時にも実行待ちの記録を解放します。これらはアプリの防御であり、回線を埋めるDDoSへの対策にはなりません。公開するホスト側でも接続頻度・リソースを制限してください。

公開前に次を実接続で確認します。

1. 外部PCの2人がそれぞれのOpenAI認証で登録し、許可していない人は登録できない。
2. 各自が選んだリポジトリにだけタスクが入り、本人確認・拒否・追加指示・切断が期待どおりに働く。
3. 期限切れや再利用した参加コード、失効した鍵を拒否し、旧接続からの結果が新接続へ混ざらない。
4. TLS証明書が有効で、ローカルUIなど余分なポートが公開されていない。
5. 進捗、エラー、Forum投稿、GitHub差分に認証情報や非公開データが含まれない。

自動テストはローカルの複数Workerと攻撃的入力を検証します。第三者によるセキュリティ監査、実TLS終端、異なるPCの実OpenAIアカウントを使った検証の代わりにはなりません。
