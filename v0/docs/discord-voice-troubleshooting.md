# Discord音声Codex 診断ガイド

## 安全な確認順序

次の順で実行する。最初の2つはBot token、OpenAI API key、Codex認証を必要とせず、外部サービスへ接続しない。

1. `npm run inspect:discord:voice:offline`
2. `npm run smoke:discord:voice:mock`
3. `npm run smoke:discord:voice:local -- /path/to/codex-home`
4. `npm run doctor:discord:voice`
5. 資格情報を設定してから`npm run inspect:discord:voice`
6. 必要な場合だけ`npm run smoke:discord:voice:codex -- /path/to/workspace`

診断JSONを共有するときは`code`、`message`、`action`だけを使う。`.env`、Bot token、OpenAI API key、`auth.json`、生errorは共有しない。

## 設定診断code

| code                            | 意味                                                       | 対応                                                                     |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------ |
| `REQUIRED_ENVIRONMENT_MISSING`  | 必須の公開設定、または完全診断に必要なAPI keyがない        | offlineでは`fields`をshellへexportし、fullでは`.env`へ追加して再実行する |
| `CONFIG_INVALID`                | ID、制限値、sandboxなどの設定が許容範囲外                  | `.env.example`とMVP仕様を参照して値を修正する                            |
| `BOT_CREDENTIAL_MISSING`        | 完全診断でBot資格情報を取得できない                        | リポジトリ外の資格情報ストアを設定し、token自体はログへ出さない          |
| `WORKING_DIRECTORY_UNAVAILABLE` | Codex作業ディレクトリが存在しない、またはdirectoryではない | 絶対パスとWSLからの可視性を確認する                                      |
| `CODEX_ISOLATION_UNAVAILABLE`   | 安全な隔離`CODEX_HOME`を準備できない                       | 認証元、状態ファイルの親directory、権限を確認し、元の設定を上書きしない  |

## 実行時code

| code                          | 意味                                                    | 対応                                                                      |
| ----------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------- |
| `CODEX_HOME_INVALID`          | 認証元または隔離先の形状が安全条件を満たさない          | symlinkや空でない隔離configを手作業で上書きせず、対象パスを確認する       |
| `CODEX_HOME_ISOLATION_FAILED` | 隔離homeの作成または検証に失敗した                      | 親directoryの権限と空き容量を確認してlocal smokeを再実行する              |
| `CODEX_AUTH_EXPIRED`          | Codex認証を更新できない                                 | 認証元を確認し、必要な場合だけCodex CLIで再認証する                       |
| `STAGE_TIMEOUT`               | STT、Codex、TTS、投稿、再生のいずれかが上限時間を超えた | 対応stageとサービス状態を確認し、同じ発話を短くして再試行する             |
| `SERVICE_STOPPED`             | 停止処理により進行中turnが中断された                    | 意図した停止なら対応不要。意図しない場合はsignalとVoice切断を確認する     |
| `UNEXPECTED_ERROR`            | 固定分類に該当しない内部失敗                            | 秘密を除いたerror codeとstageだけを保存し、`npm run verify`から再確認する |

オフライン診断の`ready: true`は公開設定が有効であることだけを示す。Discordへ接続可能という意味ではない。実接続前にはdoctorの全local checkと完全診断の`serviceReady: true`を確認する。結果は[検証記録](./discord-voice-verification.md)へ追記する。
