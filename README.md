# IDO Engine / Client

The self-hosted IDO rewrite is distributed as `@ido/engine`, `@ido/client`, and optional `@ido/plugin-discord`. New code lives in `packages/`; Engine and Client ship prebuilt React + Mantine dashboards.

See [installation, architecture, security boundaries and release validation](docs/ido-engine-client.md). The package names are provisional and not published by this change. Existing hub integrations and data remain below; legacy commands do not configure the new IDO runtime.

```sh
npm ci
npm run verify:ido
npm run pack:ido
```

---

# 井戸Bot — 会話の中で、話す・作る・試す

Discordの会話を共有コンテキストへ整理し、Codexの調査・実装・ベンチマークを会議と並行して進めるBotです。
結果、検証記録、コード差分が会話に戻り、その場で追加指示・中断・差分反映まで行えます。
Discordの音声・テキストと、ブラウザの共有スタジオに対応しています。Slack・VRChatの音声接続は未実装です。

ブラウザでは、中央の成果を触りながら、会話・追加指示・二案比較を同じエンジンで進められます。Discordを使わず始める方法と、音声Botへ画面をつなぐ方法は、[共有スタジオの起動・設計・デモガイド](docs/shared-studio.md)を参照してください。

## 最初の5分

Node.js 22以降、Discord Bot、音声API用のOpenAI API key、Codexへのログインが必要です。実行途中の訂正とプレビューにはCodex CLI 0.154.0以降を使います。
`.env.voice.example` を参考に、対象サーバー・通話・テキストチャンネル・操作担当者・作業repoを指定します。
実際の設定と認証情報はGit管理外へ置いてください。

```sh
npm ci
npm run doctor:discord:voice
npm run inspect:discord:voice:instance -- YOUR_PROFILE
npm run start:discord:voice:instance -- YOUR_PROFILE
```

グループ開発では `PERSONAL_CONTEXT_VOICE_MODE=meeting`、`PERSONAL_CONTEXT_VOICE_POWER_MODE=true`、`PERSONAL_CONTEXT_VOICE_LISTEN_TO_EVERYONE=true` を設定します。
通常のCodex処理はSol lowです。複雑さを理由にAstraへ切り替えません。Astraは作業作成時の `model` 選択か「Astraで実装して」など、その作業で明示された場合だけ使用します。過去の環境設定がAstraでも自動選択には使いません。`OBSERVER`・`TASK`・`COMPLEX_TASK` の推論強度を明示した設定は優先されるため、既存環境のhighやmediumをlowへ変更し、`inspect` で実効設定を確認してください。
Botには対象チャンネルでの閲覧・接続・発言・送信・履歴閲覧・公開スレッド作成・スレッド送信・ファイル添付を許可し、Developer PortalでMessage Content Intentを有効にします。

1つのBotへ複数のCodexエージェントを接続する場合は、`PERSONAL_CONTEXT_VOICE_CODEX_AGENTS` にエージェントのJSON配列を設定します。各要素は `id`、`name`、担当判定に使う `capabilities`、並行数、対象repo、任意の専用Discordチャンネル、モデル設定を持ちます。Issueは担当領域と現在の負荷から割り当て、担当と理由を保存してから実行します。`PERSONAL_CONTEXT_VOICE_ISSUE_FORUM_CHANNEL_ID` を設定するとIssueごとにForum投稿を作り、進捗・質問・指摘・回答を同じスレッドへ集約します。エージェント別アイコンを使う場合はForumでのWebhook管理権限も必要です。

参加者が自分のPCとCodex認証で参加する場合は、Bot側でWorker Gatewayを有効にします。Gatewayはloopbackへbindし、外部公開時はTLS reverse proxyを通した `wss://` URLだけを公開してください。Windowsの参加者は **IDO Agent** をインストールし、接続設定の「OpenAIでログイン」から公式ページで認証します。Discordの `/ido agent connect` で本人だけに表示された参加情報をアプリへ貼り付け、作業フォルダーを選ぶと参加できます。タスク一覧で進捗・結果を確認し、個別停止できます。[参加手順と主催者の設定](docs/discord-agent-participant.md)を参照してください。

初回はDiscordの **`/ido agent setup` → インストーラーを入手・インストール → Windowsのスタートメニューで「IDO Agent」を起動** の順に進みます。次回からはスタートメニューでアプリを開いて再接続します。開発者のビルド、ローカル起動、主催者がBotへ案内を反映する手順は[アプリのビルド・配布・起動ガイド](docs/agent-desktop-development.md)を参照してください。

CLIを使う場合の接続方法も残しています。

```powershell
Copy-Item .env.agent.example .env.agent
Write-Output '<PAIRING_CODE>' | npm run agent:pair -- --gateway wss://agents.example.com --workdir C:/path/to/repository --capabilities frontend,test --allow-automatic
```

初回pairing後は `npm run start:discord:agent -- --allow-automatic` で再接続できます。Workerは端末内でEd25519鍵を作り、WindowsではWorker tokenと秘密鍵をCurrentUser DPAPIへ、Linuxではmode `0600` のファイルへ保存します。Codex・Discord・GitHubのcredentialはBotへ送らず、Bot側にはWorker tokenのSHA-256 hashと公開鍵だけを保存します。Codex threadと分離worktreeの対応も担当者端末だけに保存します。`/ido agent disconnect` で登録を失効でき、`/ido agent status` で接続状態を確認できます。

起動すると通話に参加し、認識テキストの保存とAI音声の使用をチャンネルへ告知します。参加者へ保存範囲を説明してから利用してください。

設定済みのテキストチャンネルで、次の流れを試せます。`/ido` は登録されたスラッシュコマンドです。`!ido` と通常のスレッド投稿にはMessage Content Intentが必要です。無効な場合もスラッシュコマンドとカードのボタン・入力フォームは使えます。

1. 「決定: ボタンは青にする」と書くか話す。議事録・前提・決定事項・未解決点・TODOを更新します。
2. `!ido task ボタンを青に変更してテストして`。専用スレッドと独立した作業場所を作ります。
3. 会話を続けながら `!ido benchmark AとBを同じ条件で比較して`。既定では2件まで並行実行します。
4. タスクカードの「追加指示」から変更を伝えます。App Server接続では実行中のターンにも訂正を届けます。モデルの切り替えは次のターンで行います。「停止」はそのタスクだけを止めます。
5. プレビューを設定したWebアプリはカードのURLから試せます。「この版を試した」で試用報告を残し、感想は同じタスクへの追加指示で伝えます。添付patchと検証記録を確認し、「差分を反映」で元の作業場所へ反映できます。

声で依頼するときは「井戸Bot、〜して」または「Codex、〜して」と呼びかけます。
既定では呼びかけを含む操作担当者の明確な依頼だけを作業候補にします。認識誤りがある場合はテキストコマンドを使えます。
「井戸Bot、タスク ID を停止して」や、対象が一つのときの「井戸Bot、今の作業を止めて」は、発話の認識完了後に会話分析を待たず停止します。対象が複数ある場合やIDが見つからない場合も、停止していないことと対象の確認方法をすぐに返します。引用・仮定の話は即時処理に含めません。
「井戸Bot、進捗を教えて」などの作業状況の質問も、参加者が保存済みの状態から直接確認できます。実行中・待機・失敗の件数を短く読み上げ、テキストには確認時刻と主なタスクIDを表示します。
通常の質問への回答を待つ間は、会話ログ欄に処理中の状態を表示します。会話の確認に失敗した場合は再試行待ちと表示し、発言を保持して次の確認でやり直します。認証切れなど対応が必要な場合は、その案内も表示します。その間も続けて話したり、停止や進捗の確認を依頼したりできます。
会話の確認は既定60秒で打ち切り、発言を保持して再試行に回します。`PERSONAL_CONTEXT_VOICE_OBSERVER_TIMEOUT_MS` で変更できます。この時間制限で背景の作業は中断しません。
読み上げ中でも次の質問を処理してテキストで回答し、進捗や停止の通知も返します。音声の返答は重ならないよう順番に読み上げます。
操作担当者は「井戸Bot、読み上げを止めて」または `!ido quiet` で、現在と待機中の読み上げを止められます。停止前の質問への回答はテキストで受け取り、次の質問から音声の応答を再開します。背景の作業は続行します。
回答のテキストは送信前に保存します。通信失敗や再起動の後は保存済みの送信位置から再送し、`/ido status` に再送待ちを表示します。会議を切り替えた後に届いた回答には、以前の会議への回答だと表示・読み上げます。
回答・操作通知・作業結果・差分添付・タスク開始カードには固定の送信IDも付けます。Discordの[重複送信防止](https://docs.discord.com/developers/resources/message)が有効な数分間は、届いたか不明な通知を再試行しても新しい投稿を作りません。スレッド作成の応答を受け取れなかった場合は、開始カードのIDで作成済みのスレッドを確認し、同じ場所に復帰します。この期間外では、送信成功直後・保存直前に終了した場合の重複が残ることがあります。

| 操作                       | 内容                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| `!ido ask 質問`            | 会議の文脈で質問する                                                       |
| `!ido context`             | 共有コンテキストの全文                                                     |
| `!ido task 依頼`           | 実装・修正                                                                 |
| `!ido research 調査内容`   | 調査                                                                       |
| `!ido benchmark 比較内容`  | ベンチマーク                                                               |
| `!ido test 検証内容`       | テスト・検証                                                               |
| `!ido status [ページ番号]` | 通話状態と作業一覧。進行中・受付待ちを先に表示し、過去の作業もページで確認 |
| `!ido result ID`           | 保存済みの結果と対応する検証記録。現在の作業状態も表示                     |
| `!ido follow ID 追加指示`  | 同じCodexセッションへ追加。App Serverでは実行中にも受け渡し                |
| `!ido stop ID`             | 指定タスクを中断し、待機中の追加指示も破棄                                 |
| `!ido quiet`               | 現在と待機中の読み上げを停止                                               |
| `/ido live on` / `off`     | GPT-Liveを30分間比較し、元のSTT/TTS方式へ戻す                              |
| `!ido reconnect`           | 通話へ再接続。進行中の作業と会議の文脈を保持                               |
| `!ido apply ID 実行版`     | 確認した実行版の差分を元の作業場所へ反映                                   |
| `!ido new`                 | 会議の境界を切り替える。過去ログ・作業は保持                               |

## 試用版と音声方式

Webプレビューは `.env.voice.example` の `PREVIEW_COMMAND_JSON` と `PREVIEW_CHECKS_JSON` で起動コマンドと操作条件を指定します。起動コマンドは運用者の設定からだけ読み、Codexのworkspace権限を使って別プロセスで実行します。Bot tokenやAPI keyは渡しません。Chromiumで指定した表示・クリック・入力を確認し、実行版に対応するスクリーンショットをローカルの成果物へ保存します。

カードは「起動済み」「自動操作を確認」「人の試用報告」を分けます。localhostの起動だけでは4人が試せるとは表示しません。別端末へ共有する場合は、別途許可・設定したprivateな転送先を `PREVIEW_SHARED_URL_TEMPLATE` へ指定し、各人が同じ版を試して報告します。訂正すると旧プレビューを停止し、新しい実行版で起動します。プレビューは1時間で終了し、Bot再起動後に古いリンクを稼働中扱いしません。

`/ido live on` はGPT-Liveのclient delegationを使う30分の比較セッションです。声は1セッションへ混ぜ、話者のID・権限は並行する話者別STTとBotの状態で確認します。人が話し始めると再生待ち音声を破棄します。Liveの切断や期限終了時はSTT/TTSへ戻り、開発作業は続けます。生音声の保存は有効にしません。従来方式とLive方式の多人数での品質は、同じ会話で比較してください。

## 並行作業と復旧

- Codexの観測・質問調査・開発は既定でSol low。従来方式の短い質問判定は4.1-mini、STT/TTSとLiveには音声用モデルを使います。Astra highの指定は該当タスク内だけで有効です。
- 会議の前提・決定・提案には根拠発言と時刻を残します。直近200発言・最大12万文字から関連する発言を選び、決定の解釈と一緒に渡します。これは保存済み全文を毎回読む方式ではありません。訂正には仕様版を付け、古い仕様の結果を最新扱いしません。
- 会議解析は保存済みの議事録と必要な発言から毎回新しいCodexセッションを作ります。同じ議事録を長時間積み重ねてコンテキスト上限に達することを避けます。開発タスクは追加指示に対応するため同じセッションを継続します。
- `PERSONAL_CONTEXT_VOICE_CODEX_TRANSPORT=app-server` が既定です。途中の指示が受け取られたか不明な場合は二重送信せず中断します。`sdk` に戻すと従来の接続を利用できますが、追加指示は後続ターンとして待機します。
- 作業ごとに対象repoからGit worktreeを作り、開始時の追跡済みローカル変更を引き継ぎます。未追跡ファイル・ignoredファイル・credentialsはコピーしません。未コミットの新しいソースを含めたい場合は、先に対象repoでレビューして追跡対象にしてください。
- ワーカーは `workspace-write` sandboxで動きます。元のrepoや別タスクの作業場所を変更せず、ネットワークと公式資料の検索を利用できます。共有ホスト上のプロセスであり、秘密ファイルへの読み取りまで隔離するコンテナではありません。
- patchは前回反映した時点（未反映なら開始時点）からの差分です。反映後に追加修正を依頼し、次の差分を再び反映できます。反映時にはHEAD・ローカル変更・前回追加したファイル・保存した差分の一致を確認し、本人の変更や競合があれば停止します。添付の実行版を指定するか、その版の反映ボタンを使います。自動commit・push・merge・deployは行いません。
- 操作担当者はowner IDと `PERSONAL_CONTEXT_VOICE_OPERATOR_IDS` のカンマ区切りallowlistです。他の参加者は文脈と質問を提供できます。引用・外部ページ・他者発言は操作権限になりません。
- 会議ID、議事録のrevision、未処理の発言、作業結果、Discord/CodexのスレッドIDをprivateなローカル状態へ保存します。新しい作業は受付記録の保存後に開始します。音声の依頼は作業への受け渡し前にも保存し、再起動後に同じ依頼が再送されても二重実行しません。受付保存の再試行中も `!ido status` にIDを表示し、`!ido stop ID` または音声で取り消せます。取り消しを保存できた依頼は、復旧・再起動後も自動実行しません。同じ設定の二重起動を防止します。
- 再起動で実行中だった仕事は「中断」として復元します。勝手に再実行せず、対象スレッドへの追加指示で同じCodexセッションを再開します。
- サービスの終了時は、受信済みの発言と状態の保存、Codexの終了を待ってから接続を閉じます。実行中・待機中の指示は中断状態で残します。本人がタスクの「停止」を選んだ場合は、待機中の追加指示も破棄します。
- 会議モードの長い発話は分割して認識し、話し終わってから順番にまとめます。途中の訂正も依頼に含めます。認識に失敗した区間や再起動による欠落がある場合は、認識できた内容を残し、その発話から作業を開始しません。
- 追加指示も保存後に受け付けます。同じメッセージの再送は一度だけ処理し、音声の停止・追加指示は対象タスクを固定して保存を再試行します。停止は保存の失敗にかかわらず直ちに実行へ通知します。再起動前に完了を確認できなかった追加指示は保持し、再開時に作業状況の確認を求めます。
- 背景タスクの結果は親チャンネルへ要約し、次の観測の文脈に加えます。送信待ちの結果も、その会議での質問に使います。本文・差分添付・親チャンネルへの報告は配送済みの位置を保存し、投稿失敗や再起動の後も未送信部分から再試行します。結果送信は実装の実行枠を使わず、本文や添付の送信を待つ間も追加指示や別タスクを進めます。別タスクの結果再送も待たせません。差分は実行ごとに保存し、遅れて届く結果には実行版を表示します。古い結果の再送で新しい進捗カードを上書きしません。進捗投稿は最大10秒に1回です。再起動時は中断・未送信タスクを優先して復旧し、完了済みのスレッドは追加指示や差分反映の際に読み直します。
- 検証履歴は実行版ごとに記録し、カードと結果の先頭に表示します。成功・失敗は確認できた検証コマンドの終了コードに基づきます。複雑なシェル式など、自動で判定できない実行を成功扱いしません。テストの網羅性や実機動作まで保証する表示ではありません。
- 複数タスクがあるときの曖昧な音声中断は実行しません。IDか対象スレッドを指定してください。

## 検証と再現

```sh
# 音声・会話・操作・復旧を外部接続なしで検証
npm test
npm run smoke:discord:voice:mock

# 実際のCodexが2本の作業を実行。Discordには接続しない
npm run smoke:discord:voice:idd

# 合成音声だけでTTS→STTを実API検証。録音・Discord投稿なし
npm run smoke:discord:voice:audio

# 合成音声の依頼→実装・検証→結果への質問→回答の復旧→差分反映
npm run smoke:discord:voice:conversation
npm run smoke:discord:voice:cancel

# Chromiumの操作を含む試用→訂正→再試用。loopは実Codexを使用
npm run smoke:discord:voice:preview
npm run smoke:discord:voice:loop

# 合成音声でLiveの委任と音声出力を確認。Discordには接続しない
npm run smoke:discord:voice:live
```

実Codexのsmokeは、一時repo内で「加算バグの修正とテスト」と「Array.includes / Set.hasの比較」を並行実行します。
修正後のテストをBot外から再実行し、元repoが変わっていないことを検査します。投稿失敗を模擬して状態を復元し、Codexを再実行せず本文・添付を返せることも確認します。その後、差分を反映して同じCodexセッションへ追加指示を渡し、以前の差分が保たれること、2回目の差分反映と反映先でのテストを検査します。検証用workspaceとJSONレポートの場所を出力します。
音声APIのsmokeは有料APIを呼びます。通常のunit/integration testは外部接続しません。
`conversation` は一時repoだけを変更し、既存テストと元repoが保たれることを検査します。実際のCodex・音声認識・音声合成を使い、差分の送信失敗中に作業結果を質問します。さらに、回答の送信完了が不明になったケースから会議セッションを復元して再送し、差分送信も復旧します。Discordへの接続とスピーカーからの再生は模擬です。結果は表示される一時ディレクトリの `report.json` で確認できます。
`cancel` は進捗と中止通知の送信を意図的に止めた状態で、実Codexの停止と同じセッションでの再開を確認します。元repoを変えず、以前の通知が再開後の完了状態を上書きしないことも検査します。Discordには接続しません。

2026-09-12のローカル実機検証では、実Codexの並行作業と独立したテスト、合成音声のTTS→STTが通過しました。
Discordの実通話・実投稿・ボタン操作は別の実機確認が必要です。mockの成功をDiscord接続の成功として扱いません。
Codex連携は[App Server](https://learn.chatgpt.com/docs/app-server)を既定とし、[公式SDK](https://learn.chatgpt.com/docs/codex-sdk)も退避用に残しています。プレビューは[Codexの権限プロファイル](https://learn.chatgpt.com/docs/permissions)を使います。音声受信は[@discordjs/voice](https://discord.js.org/docs/packages/voice/0.19.2)を使用しています。Discordの音声受信にはライブラリ側のサポート上の制約があり、環境ごとの実通話確認が必要です。

このrepoは旧personal-context-hubから分岐しており、以下に既存の連携・設定資料を保持しています。

## Requirements

- Node.js 22 or later;
- Windows and WSL for the DPAPI and Discord desktop RPC workflows;
- the relevant service application and OAuth credentials;
- Thunderbird with a local global search index for the mail MCP.

Non-interactive WSL launches resolve Node from `PERSONAL_CONTEXT_NODE`, the
current `PATH`, or an installation below `$HOME/.nvm`, in that order.

## Install and verify

```sh
npm ci
npm run verify
```

`npm run verify` performs syntax checks, ESLint, Prettier validation, test
coverage checks, and an npm dependency audit.

## Local configuration

Copy `.codex/config.example.toml` to `.codex/config.toml`, review the commands,
replace every placeholder path, and enable only the sources you intend to use.
The live config is ignored because absolute paths and enabled integrations can
reveal local or private operational details.

All local MCPs should remain `required = false`: a temporarily unavailable
source must not prevent an unrelated Codex task from starting.

For a local-only instruction layer, place personal routing and publication
rules in the ignored `AGENTS.override.md`. Do not commit that file.

## Authentication

### traQ

```sh
npm run auth:traq -- --client-id YOUR_PUBLIC_CLIENT_ID
npm run smoke
```

The OAuth grant requests `openid profile read write manage_bot`. Use a separate
client intended for this local tool and revoke it if the workstation or client
is compromised.

### Discord user Reader

Create a separate Discord application with `http://localhost` as the redirect
URI. Store its Client Secret from Windows PowerShell, then authorize the reader:

```powershell
.\scripts\store-discord-rpc-secret-from-clipboard.ps1 -ApplicationId YOUR_APPLICATION_ID
```

```sh
npm run auth:discord:user
npm run smoke:discord:user
```

The Reader does not extract a normal user token, connect the user account to the
Gateway, or provide user-account write tools.

### Discord Bot

The Bot adapter is optional and should stay disabled until a dedicated Bot has
been installed with narrowly scoped permissions. Pass the token over stdin:

```sh
printf '%s' "$DISCORD_BOT_TOKEN" | npm run auth:discord -- --application-id YOUR_APPLICATION_ID
```

Avoid placing tokens in command arguments or shell history. Clear the shell
variable immediately after use.

### Discord Voice to Codex

The Voice bridge uses the same dedicated Bot credential, but additionally needs
the exact Guild, Voice channel, Text channel, and owner user IDs. Copy
`.env.example` to the ignored `.env`, replace every placeholder needed by the
Voice bridge, set a repository working directory for Codex, then run. The Voice
start and full inspection scripts load `.env` when it exists; the offline
inspection does not:

```sh
npm run inspect:discord:voice:offline
npm run smoke:discord:voice:mock
npm run doctor:discord:voice
npm run inspect:discord:voice
npm run start:discord:voice
```

Run multiple independent Bot applications from the same checkout by keeping one
ignored `.env.voice.<profile>` per server. The profile overrides the shared
ignored `.env`; give every profile distinct Discord token, meeting state, and
isolated Codex home paths. The tracked `.env.voice.example` is the template.

```bash
npm run auth:discord:voice:instance -- tdm --application-id 11111111111111111
npm run inspect:discord:voice:instance -- tdm
npm run start:discord:voice:instance -- tdm
```

The offline inspection intentionally does not load `.env`; export only the five
public `PERSONAL_CONTEXT_VOICE_*` IDs/path variables when running it. It checks
their syntax and the working directory without reading the Bot credential,
OpenAI API key, or Codex authentication. The mock smoke drives synthetic PCM
through receive, WAV conversion, fake STT/Codex, Text/TTS, and playback without
network access. Add credentials only after the doctor reports all local gates
passed. See the [Voice diagnostic guide](docs/discord-voice-troubleshooting.md)
and [preflight checklist](docs/discord-voice-preflight-checklist.md) for stable
error codes and the remaining verification order.

When the service runs in WSL, set `PERSONAL_CONTEXT_VOICE_CODEX_HOME` to the
WSL path of the signed-in Windows Codex App home (for example,
`/mnt/c/Users/YOU/.codex`). This reuses the existing ChatGPT sign-in without
copying credentials into the repository. The path is used only as the
authentication source: before Discord login, the service creates a private,
isolated Codex home beside its state file, symlinks only `auth.json`, and
requires an empty `config.toml` or only Codex-generated trust records for the configured workspace. Set
`PERSONAL_CONTEXT_VOICE_ISOLATED_CODEX_HOME` only when that default location
must be changed. An unexpected auth file, unrelated configuration, or unsafe directory
causes startup to fail without reading the Bot credential.

The Codex child process receives only an allowlisted runtime environment, so the
Discord Bot token and audio API key are not inherited. Normal voice turns run
with Codex network access and web search disabled; their supported sandboxes are
`read-only` and `workspace-write`. The Windows Codex App `config.toml` is never
loaded, so an unrelated or incompatible local MCP entry cannot prevent the
bridge from starting.

The Bot must have View Channel, Connect, Speak, Send Messages, and Read Message
History only in those two channels. It does not use a Discord user token. By
default, the bridge accepts audio only from the configured owner ID. Set
`PERSONAL_CONTEXT_VOICE_LISTEN_TO_EVERYONE=true` to accept every speaker in the
configured Voice channel, and tune playback with
`PERSONAL_CONTEXT_VOICE_TTS_SPEED` from `0.25` through `4`. In turn mode, turns are serialized,
the transcript and full response are posted to the configured Text channel, and
an AI-generated excerpt is spoken. Audio bytes are not persisted. See
[the Voice MVP specification](docs/discord-voice-codex.md) for limits and trust
boundaries.

Bot messages use Discord's suppressed-notification flag by default, including
task-thread posts. Set `PERSONAL_CONTEXT_VOICE_SILENT_MESSAGES=false` only when
normal push and desktop notifications are wanted. This does not hide messages
or remove Discord's unread state.

For group development sessions, set `PERSONAL_CONTEXT_VOICE_MODE=meeting`.
Meeting mode transcribes speakers in parallel, edits one live transcript message,
and, by default, observes accumulated speech immediately after transcription.
Set `PERSONAL_CONTEXT_VOICE_IMMEDIATE_REACTIONS=false` to use only the periodic
`PERSONAL_CONTEXT_VOICE_OBSERVATION_INTERVAL_MS` fallback. Each observation
updates one cumulative minutes message. Codex posts and speaks only when the
accumulated speech contains an unresolved question, request, correction, or another useful
reason to intervene; ordinary conversation and acknowledgements update the
minutes without producing a reply.

Every non-empty recognized statement is also retained indefinitely as append-only
JSONL outside Git under `PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_DIR`, grouped
by guild and local date. Records include the speaker, timestamps, source IDs, and
the exact recognized text; raw audio is never stored. By default, the same records
are batched every minute into a silent `会話ログ YYYY-MM-DD` Discord thread for
convenient browsing. Set `PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_DISCORD=false`
to keep only the canonical local archive, or change
`PERSONAL_CONTEXT_VOICE_TRANSCRIPT_ARCHIVE_FLUSH_INTERVAL_MS` to adjust the Discord
batch interval. A Discord publishing failure does not remove the local record.

Set `PERSONAL_CONTEXT_VOICE_POWER_MODE=true` to let the configured owner create
background Codex tasks from meeting speech. Each task runs in a separate thread and Git worktree with a workspace-write
sandbox, live web search, network access, and no interactive approval prompt. Only configured operators can authorize work; other speakers remain meeting context. Power tasks may run concurrently without blocking the next meeting
observation. The configured Text channel receives one starter message per task;
that message is updated from queued through completed, failed, or cancelled and
always links to the task thread. The thread contains the request, curated Codex
progress, final result, and elapsed time, so meeting transcripts and minutes
remain readable in the parent channel without hiding task status.
These are persistent local Codex worker sessions, not new tasks in the Codex App
sidebar. Apps, browser sessions, plugins, hooks, and MCP servers remain disabled
unless separately integrated.

The configured owner or operator can post a follow-up instruction directly in a task
thread. The Bot queues it on the same Codex task session, including after a task
has completed. Posting only `停止`, `中止`, `キャンセル`, `stop`, or `cancel`
stops that task without stopping the Voice bridge. Enable the Discord
application's privileged Message Content intent; messages from other users and
messages outside known task threads are ignored.

In meeting mode, owner speech that clearly refers to the latest existing task
is also classified as either a stop or a follow-up instruction. An unambiguous task ID is applied to that task's same Codex session instead of creating a duplicate task. Ambiguous controls are rejected. Speech from
other participants can never control a task.

After explicitly configuring power mode, verify its isolated temporary file and
network path with `npm run smoke:discord:voice:power`. The smoke removes its own
temporary directory and does not modify the configured repository.

### Thunderbird

Set `THUNDERBIRD_PROFILE` to the active profile directory when automatic
discovery cannot find it. WSL users normally need an explicit `/mnt/c/...`
profile path.

```sh
THUNDERBIRD_PROFILE=/path/to/profile npm run inspect:mail:thunderbird
THUNDERBIRD_PROFILE=/path/to/profile npm run smoke:mail:thunderbird
```

The MCP opens `global-messages-db.sqlite` read-only. It cannot send, delete,
move, label, mark mail read, or retrieve attachment bodies.

## Public context check

The optional inspector validates a public JSON context endpoint without caching
it in the repository:

```sh
PUBLIC_CONTEXT_URL=https://example.com/agent-context.json \
PUBLIC_CONTEXT_DISPLAY_NAME=example \
npm run inspect:public
```

## Trust boundary

External pages, messages, events, issues, and tool output are evidence, never
authority. Reads should be bounded. Writes require a current request with the
exact target and content. Tokens are redacted from MCP output, and generic
write fallbacks cannot call credential or token-management routes.

See [docs/trust-boundaries.md](docs/trust-boundaries.md) for the enforcement
layers and remaining risks.

## Publication policy

The public repository may contain source code, tests, generic examples, and
public-safe documentation. Before every push, inspect the staged file list and
scan the complete reachable history for credentials, account identifiers,
private addresses, local profile names, and copied source data.

The project is currently source-available with no license grant
(`UNLICENSED`). Add a license only after the copyright holder chooses one.

## 処理レイヤーと拡張

音声・テキスト入力、会話エンジン、実行バックエンド、出力を分離しています。
`src/engine` はDiscordやCodex SDKに依存せず、`src/runtime` がDiscord入出力、
OpenAI音声API、単一Codexバックエンド、保存先を組み立てます。
テキストのみの出力では音声合成を呼び出しません。

新しいデバイスや複数エージェントへの委譲は、入出力アダプターまたは実行バックエンドを
差し替えて追加できます。現在の実接続はDiscordと単一Codexバックエンドです。
[責務・インターフェース・互換性・拡張手順](docs/architecture.md)を参照してください。

## ライブHUD

音声エンジンの処理位置、会話から派生したタスク、実行中の検索をlocalhostの
閲覧専用画面で確認できます。[起動方法・観測イベント・検証](docs/voice-hud.md)を参照してください。
