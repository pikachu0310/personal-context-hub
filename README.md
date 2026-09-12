# 井戸Bot — 会話の中で、話す・作る・試す

Discordの会話を共有コンテキストへ整理し、Codexの調査・実装・ベンチマークを会議と並行して進めるBotです。
結果、検証記録、コード差分が会話に戻り、その場で追加指示・中断・差分反映まで行えます。
現在の実装対象はDiscordです。Slack・VRChatの音声接続は未実装です。

## 最初の5分

Node.js 22以降、Discord Bot、音声API用のOpenAI API key、Codexへのログインが必要です。
`.env.voice.example` を参考に、対象サーバー・通話・テキストチャンネル・操作担当者・作業repoを指定します。
実際の設定と認証情報はGit管理外へ置いてください。

```sh
npm ci
npm run doctor:discord:voice
npm run inspect:discord:voice:instance -- YOUR_PROFILE
npm run start:discord:voice:instance -- YOUR_PROFILE
```

グループ開発では `PERSONAL_CONTEXT_VOICE_MODE=meeting`、`PERSONAL_CONTEXT_VOICE_POWER_MODE=true`、`PERSONAL_CONTEXT_VOICE_LISTEN_TO_EVERYONE=true` を設定します。
モデルと推論強度は `PERSONAL_CONTEXT_VOICE_CODEX_MODEL` / `PERSONAL_CONTEXT_VOICE_CODEX_REASONING_EFFORT` を共通設定とし、`OBSERVER`・`TASK`・`COMPLEX_TASK` ごとの指定を優先します。複雑な作業の設定を省略すると `TASK` を引き継ぎます。例の設定では会議観測をSol low、作業をSol mediumに分けており、`inspect` で実効設定を確認できます。
Botには対象チャンネルでの閲覧・接続・発言・送信・履歴閲覧・公開スレッド作成・スレッド送信・ファイル添付を許可し、Developer PortalでMessage Content Intentを有効にします。
起動すると通話に参加し、認識テキストの保存とAI音声の使用をチャンネルへ告知します。参加者へ保存範囲を説明してから利用してください。

設定済みのテキストチャンネルで、次の流れを試せます。`!ido` はテキストコマンドです。`/ido` も同じ意味で受け付けます。

1. 「決定: ボタンは青にする」と書くか話す。議事録・前提・決定事項・未解決点・TODOを更新します。
2. `!ido task ボタンを青に変更してテストして`。専用スレッドと独立した作業場所を作ります。
3. 会話を続けながら `!ido benchmark AとBを同じ条件で比較して`。既定では2件まで並行実行します。
4. タスクカードの「追加指示」から変更を伝えます。「停止」はそのタスクだけを止めます。
5. 結果と添付patch・検証記録を確認し、「差分を反映」で元の作業場所へ反映します。そのrepoの通常の起動コマンドで動作を試せます。

声で依頼するときは「井戸Bot、〜して」または「Codex、〜して」と呼びかけます。
既定では呼びかけを含む操作担当者の明確な依頼だけを作業候補にします。認識誤りがある場合はテキストコマンドを使えます。
「井戸Bot、タスク ID を停止して」や、対象が一つのときの「井戸Bot、今の作業を止めて」は、発話の認識完了後に会話分析を待たず停止します。引用・仮定の話や、対象が複数ある曖昧な停止はこの即時処理に含めません。
「井戸Bot、進捗を教えて」などの作業状況の質問も、参加者が保存済みの状態から直接確認できます。実行中・待機・失敗の件数を短く読み上げ、テキストには確認時刻と主なタスクIDを表示します。

| 操作                       | 内容                                                   |
| -------------------------- | ------------------------------------------------------ |
| `!ido ask 質問`            | 会議の文脈で質問する                                   |
| `!ido context`             | 共有コンテキストの全文                                 |
| `!ido task 依頼`           | 実装・修正                                             |
| `!ido research 調査内容`   | 調査                                                   |
| `!ido benchmark 比較内容`  | ベンチマーク                                           |
| `!ido test 検証内容`       | テスト・検証                                           |
| `!ido status [ページ番号]` | 進行中・受付待ちを先に表示。過去の作業もページで確認   |
| `!ido result ID`           | 保存済みの結果と対応する検証記録。現在の作業状態も表示 |
| `!ido follow ID 追加指示`  | 同じCodexセッションへ追加。実行中は後続として待機      |
| `!ido stop ID`             | 指定タスクを中断し、待機中の追加指示も破棄             |
| `!ido apply ID 実行版`     | 確認した実行版の差分を元の作業場所へ反映               |
| `!ido new`                 | 会議の境界を切り替える。過去ログ・作業は保持           |

## 並行作業と復旧

- 観測・即答は既定でSol low、作業はSol medium。別モデルは `PERSONAL_CONTEXT_VOICE_OBSERVER_MODEL`、`PERSONAL_CONTEXT_VOICE_TASK_MODEL`、`PERSONAL_CONTEXT_VOICE_COMPLEX_TASK_MODEL` で指定できます。
- 作業ごとに対象repoからGit worktreeを作り、開始時の追跡済みローカル変更を引き継ぎます。未追跡ファイル・ignoredファイル・credentialsはコピーしません。未コミットの新しいソースを含めたい場合は、先に対象repoでレビューして追跡対象にしてください。
- ワーカーは `workspace-write` sandboxで動きます。元のrepoや別タスクの作業場所を変更せず、ネットワークと公式資料の検索を利用できます。共有ホスト上のプロセスであり、秘密ファイルへの読み取りまで隔離するコンテナではありません。
- patchは前回反映した時点（未反映なら開始時点）からの差分です。反映後に追加修正を依頼し、次の差分を再び反映できます。反映時にはHEAD・ローカル変更・前回追加したファイル・保存した差分の一致を確認し、本人の変更や競合があれば停止します。添付の実行版を指定するか、その版の反映ボタンを使います。自動commit・push・merge・deployは行いません。
- 操作担当者はowner IDと `PERSONAL_CONTEXT_VOICE_OPERATOR_IDS` のカンマ区切りallowlistです。他の参加者は文脈と質問を提供できます。引用・外部ページ・他者発言は操作権限になりません。
- 会議ID、議事録のrevision、未処理の発言、作業結果、Discord/CodexのスレッドIDをprivateなローカル状態へ保存します。新しい作業は受付記録の保存後に開始します。音声の依頼は作業への受け渡し前にも保存し、再起動後に同じ依頼が再送されても二重実行しません。受付保存の再試行中も `!ido status` にIDを表示し、`!ido stop ID` または音声で取り消せます。取り消しを保存できた依頼は、復旧・再起動後も自動実行しません。同じ設定の二重起動を防止します。
- 再起動で実行中だった仕事は「中断」として復元します。勝手に再実行せず、対象スレッドへの追加指示で同じCodexセッションを再開します。
- サービスの終了時は、受信済みの発言と状態の保存、Codexの終了を待ってから接続を閉じます。実行中・待機中の指示は中断状態で残します。本人がタスクの「停止」を選んだ場合は、待機中の追加指示も破棄します。
- 会議モードの長い発話は分割して認識し、話し終わってから順番にまとめます。途中の訂正も依頼に含めます。認識に失敗した区間や再起動による欠落がある場合は、認識できた内容を残し、その発話から作業を開始しません。
- 追加指示も保存後に受け付けます。同じメッセージの再送は一度だけ処理し、音声の停止・追加指示は対象タスクを固定して保存を再試行します。停止は保存の失敗にかかわらず直ちに実行へ通知します。再起動前に完了を確認できなかった追加指示は保持し、再開時に作業状況の確認を求めます。
- 背景タスクの結果は親チャンネルへ要約し、次の観測の文脈に加えます。本文・差分添付・親チャンネルへの報告は配送済みの位置を保存し、投稿失敗や再起動の後も未送信部分から再試行します。配送失敗で受け付け済みの追加指示を止めません。差分は実行ごとに保存します。進捗投稿は最大10秒に1回です。再起動時は中断・未送信タスクを優先して復旧し、完了済みのスレッドは追加指示や差分反映の際に読み直します。
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
```

実Codexのsmokeは、一時repo内で「加算バグの修正とテスト」と「Array.includes / Set.hasの比較」を並行実行します。
修正後のテストをBot外から再実行し、元repoが変わっていないことを検査します。投稿失敗を模擬して状態を復元し、Codexを再実行せず本文・添付を返せることも確認します。その後、差分を反映して同じCodexセッションへ追加指示を渡し、以前の差分が保たれること、2回目の差分反映と反映先でのテストを検査します。検証用workspaceとJSONレポートの場所を出力します。
音声APIのsmokeは有料APIを呼びます。通常のunit/integration testは外部接続しません。

2026-09-12のローカル実機検証では、実Codexの並行作業と独立したテスト、合成音声のTTS→STTが通過しました。
Discordの実通話・実投稿・ボタン操作は別の実機確認が必要です。mockの成功をDiscord接続の成功として扱いません。
Codex連携は[公式SDK](https://learn.chatgpt.com/docs/codex-sdk)、音声受信は[@discordjs/voice](https://discord.js.org/docs/packages/voice/0.19.2)を使用しています。Discordの音声受信にはライブラリ側のサポート上の制約があり、環境ごとの実通話確認が必要です。

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
