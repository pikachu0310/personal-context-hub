# Discord音声Codex 実接続前checklist

このchecklistは、ローカル検証と本人が行う一回限りの実接続を分離する。Bot token、OpenAI API key、Codex `auth.json`、Guild／channel／user IDはこのfileへ記録しない。

## 1. 資格情報不要のローカルゲート

- [ ] WSLのNode.jsが22以上である。
- [ ] 5つの公開環境変数（Guild、Voice、Text、owner、Codex workdir）をshellへexportした。
- [ ] `npm run inspect:discord:voice:offline`が`ready: true`になった。
- [ ] `npm run smoke:discord:voice:mock`が`VOICE_CODEX_MOCK_E2E_OK`、`externalCalls: 0`になった。
- [ ] `npm run smoke:discord:voice:local`が`VOICE_CODEX_LOCAL_OK`、MCP 0件になった。
- [ ] `npm run doctor:discord:voice`が全checkを`passed`として終了コード0になった。
- [ ] `npm run verify`、依存audit、secret scanが成功した。

ここまで失敗している場合、credentialを設定したりDiscordへ接続したりしない。doctorの`issues[].code`と[診断ガイド](./discord-voice-troubleshooting.md)だけを確認する。

## 2. 本人が行うcredential準備

- [ ] 専用Discord Bot applicationを作成し、対象Guildの限定Voice／Text channelだけへ招待した。
- [ ] Bot権限をView Channel、Connect、Speak、Send Messages、Read Message Historyに限定した。
- [ ] Bot tokenを`npm run auth:discord`のstdin経由でリポジトリ外へ保存した。tokenをshell引数、`.env`、このfileへ書いていない。
- [ ] OpenAI API keyをignored `.env`へ設定した。値をログ、診断JSON、commitへ出していない。
- [ ] Codex Appの認証元`auth.json`が存在し、隔離homeの`config.toml`を空にできる状態である。
- [ ] 実際のGuild、Voice、Text、owner user IDをallowlistへ設定し、IDをこのfileへ転記していない。

## 3. 実接続の一回限り確認（本人操作）

資格情報準備後に本人が次の順で実行する。workerはこの手順を実行しない。

1. `npm run inspect:discord:voice`で`serviceReady: true`を確認する。
2. `npm run start:discord:voice`を限定環境で起動する。
3. 起動通知、設定した話者モード、文字起こし、Codex応答、AI生成音声を確認する。
4. 会議観測モードでは複数話者の発話が一つのライブ文字起こしへ編集反映され、観測間隔まではCodex応答が発生しないことを確認する。
5. 観測後に累積議事録が更新され、応答不要な雑談ではText返信とTTSが発生しないことを確認する。
6. 未解決の質問または依頼を含む観測だけがText返信とTTSを一度ずつ実行することを確認する。
7. Powerモードでは本人の安全な調査依頼だけが別taskとして開始され、他参加者の依頼ではtaskが作られないことを確認する。
8. Power taskの実行中も次の会議観測が継続し、完了結果がTextチャンネルへ投稿されることを確認する。
9. `Ctrl+C`で停止し、Voice切断、task cancel、Bot client cleanupを確認する。
10. token、API key、音声原本、raw errorをログや共有画面へ出していないことを確認する。

## 4. 失敗時と撤回

- `BOT_CREDENTIAL_MISSING`、`CODEX_AUTH_EXPIRED`、`CODEX_HOME_*`はcredentialの再入力前に対象pathと保管場所を確認する。
- Discord接続が不要になったらプロセスを停止し、Botを限定Guild／channelから外すか権限を戻す。
- 診断結果を共有する場合は`code`、`message`、`action`だけを抜粋し、`.env`、token、key、auth file、IDを添付しない。
