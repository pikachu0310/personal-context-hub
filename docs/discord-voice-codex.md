# Discord音声Codex MVP仕様

## 目的

本人がDiscordの専用Voiceチャンネルから日本語でCodexへ依頼し、文字起こし、ローカルCodex実行、読み上げまでを一つのターンとして完結できるようにする。Discordのユーザーアカウントを自動操作せず、既存の専用Bot資格情報だけを使う。

## MVPの境界

### 会議モードの現在の操作

- `/ido join` と `/ido leave` は設定済み通話への接続・退出を行う。退出中もGatewayと背景作業は継続する。`/ido context` は議事録全文、`/ido quiet` は現在の読み上げを停止する。各操作はguildスラッシュコマンドとして登録する。
- `PERSONAL_CONTEXT_VOICE_MESSAGE_CONTENT_INTENT=false` では特権Message Content intentを要求せず起動できる。スラッシュコマンドは使えるが、通常のチャンネル投稿を文脈・追加指示として読むにはMessage Content権限が必要。
- 議事録は先頭に短い要点、添付に全文を持つ編集可能なメッセージとして表示し、可能ならBot自身の議事録メッセージをpinする。
- 即時応答は議事録生成から独立したResponses API（既定 `gpt-4.1-mini`、`PERSONAL_CONTEXT_VOICE_QUICK_REPLY_MODEL` で変更）へ渡す。ツールを実行しない短い会話用であり、音声認識・回答生成・音声合成の時間は残る。`PERSONAL_CONTEXT_VOICE_ANSWER_UNADDRESSED_QUESTIONS=true` で、呼びかけのない疑問文も対象にする。
- 開発会議で `PERSONAL_CONTEXT_VOICE_ALL_PARTICIPANTS_OPERATE=true` を指定すると、対象サーバーの参加者全員がコマンド・作業操作を使える。音声も対象にするには全話者受信を有効にする。`PERSONAL_CONTEXT_VOICE_REQUIRE_WAKE_WORD=false` で作業依頼の呼びかけ条件を外せる。
- `PERSONAL_CONTEXT_VOICE_CODEX_AGENTS` に複数のエージェントを登録すると、音声またはテキストから作ったIssueを担当領域と割当負荷で振り分ける。Issue、担当、割当理由を永続化してから作業を開始し、エージェント別の同時実行上限を守る。
- `PERSONAL_CONTEXT_VOICE_ISSUE_FORUM_CHANNEL_ID` を設定した場合はIssueごとにDiscord Forumスレッドを作り、依頼、進捗、結果、質問、指摘、担当エージェントの回答を集約する。チーム共通・エージェント別テキストチャンネルには担当決定を通知する。
- 複数エージェント時のpeer reviewでは、別エージェントが完成結果とworktreeをread-onlyで確認する。具体的な質問・指摘はIssueスレッドへ投稿し、担当エージェントの同じCodexスレッドへ、操作権限を増やさないレビュー情報として一度だけ戻す。
- 分散Workerを有効にすると、参加者はDiscordのephemeral Slash Commandで短期pairing codeを受け取り、自分のPCから中央Gatewayへ外向き接続する。通常Discord user tokenを取得せず、Codex・GitHub・repository認証はWorker端末から出さない。
- pairing時にWorkerがEd25519鍵を生成し、中央は公開鍵とWorker token hashだけを保持する。接続ごとのchallenge signature、heartbeat、task leaseで端末を確認し、切断・lease timeout時は別のonline agentへ再割当する。
- ForumへのAgent発言はAgent別managed Webhookを使う。ownerのDiscord CDN avatarへ色ringとrobot badgeをlocal合成し、Agent ID・owner・Issueを本文にも明記する。元avatarを外部画像生成serviceへ送らない。
- `PERSONAL_CONTEXT_VOICE_AUTONOMOUS_TASKS=true` では、観測担当が会話中に必要だと判断した作業を明示依頼なしで作成できる。具体的な成果と根拠発言を保持し、既存作業との重複を避ける。公開・送信・購入等への許可を会話から推測しない。
- STTへ話題の説明や固有名詞一覧を常時渡さない。送信前に無音・DC・ごく短いクリックを信号量で除く。この判定はVADではなく、雑音由来の誤認識すべてを防ぐものではない。「はい」などの認識単語を一律に破棄しない。

以下のallowlist説明は、上記の全員操作・自律タスク設定を有効にしていない既定動作を示す。

- 1 Guild、1 Voiceチャンネル、1 Textチャンネル、1本人ユーザーを環境変数でallowlistする。開発用には明示設定でVoice内の全参加者を対象にできる。
- Botは起動時に指定Voiceチャンネルへ参加する。既定では本人だけ、全参加者モードではBot以外の発話者を購読する。
- 発話終了後に音声を一つのWAVへ変換し、OpenAI Transcriptions APIの`gpt-transcribe`へ送る。
- 確定した文字起こしを同じTextチャンネルへ記録してから、会議観測用の同一ローカルthreadへ渡す。Issue作業は担当エージェントごとの別threadへ渡す。
- Codexの最終応答をTextチャンネルへ分割投稿し、`gpt-4o-mini-tts`で生成したPCMをVoiceへ返す。
- 同時発話は直列queueに積み、再生中も受信する。1ターンの失敗は次のターンを止めない。
- 会議観測モードでは話者ごとのSTTを並列実行し、確定した発話を一つのライブ文字起こしメッセージへ編集反映する。
- 会議観測モードでは既定で文字起こし完了後に未観測の発話を時系列で一括観測し、累積議事録を更新する。即時観測を無効にした場合は既定60秒ごとに観測する。未解決の質問・依頼などがある場合だけTextとTTSで応答する。
- 会議観測中に到着した発話は次回分として保持し、CodexやTTSの処理中でも短い発話ごとの混雑通知を送らない。
- Powerモードでは本人allowlistの発言だけから作業依頼を抽出し、会議観測とは別のCodex threadへqueueする。他参加者の発言は文脈には使うが操作権限には使わない。
- PowerタスクのDiscordスレッドでは本人allowlistのテキストだけを追加指示として受け付け、同じCodex threadで継続する。`停止`、`中止`、`キャンセル`、`stop`、`cancel`だけの投稿はそのタスクだけを中止する。他ユーザー、Bot、既知でないスレッドの投稿は無視する。
- 本人の会議音声が直近の既存タスクの停止・変更・追加指示を明確に指す場合、会議観測が新規taskと区別し、そのタスクの同じCodex threadへ適用する。他参加者の音声はtask操作に使わない。
- Power taskは`danger-full-access`、network有効、live Web検索、`approvalPolicy: never`で最大2件を並列実行する。taskをqueueした時点でTextチャンネルに状態カードと専用Discordスレッドを作る。カードはスレッドへのリンクを常に表示し、`待機中 → 実行中 → 完了・失敗・中止`へ更新する。依頼内容、Codex SDKの要約済み進捗、結果、所要時間はスレッドへ投稿する。
- Botの新規メッセージは既定でDiscordの`SUPPRESS_NOTIFICATIONS` flagを付け、親チャンネルとtaskスレッドのpush・desktop通知を抑制する。メッセージと未読状態は通常どおり残す。通常通知が必要な場合だけ`PERSONAL_CONTEXT_VOICE_SILENT_MESSAGES=false`にする。
- STT、Codex、TTS、再生、Discord投稿には個別の上限時間を設け、外部サービスが応答しないターンもqueueを永久に塞がない。
- 作業ディレクトリ、sandbox、モデルは明示設定する。既定sandboxは`workspace-write`とし、任意ディレクトリへの無制限書き込みを暗黙に許可しない。
- 会議観測threadは`read-only`、networkとWeb検索無効、`approvalPolicy: never`で開始する。Power taskだけは明示設定により`danger-full-access`、network有効、live Web検索を使う。
- Codex App homeは認証元としてのみ扱う。Bot資格情報を読む前に、状態ファイルと同じ親directoryへmode `0700`の隔離Codex homeを作り、元の`auth.json`だけをsymlinkし、mode `0600`の空`config.toml`を置く。SDKには追加でapps、plugins、hooks、multi-agent、MCP serverを無効にするoverrideを渡す。

## 信頼境界

- Discord上の発話は外部入力である。既定では発話者IDが本人allowlistと一致する場合だけCodex入力として扱い、全参加者モードではVoice内の各発話者を会議記録へ入れる。Power taskの根拠にできるのは本人IDと一致する発言sequenceだけとする。
- Bot tokenとOpenAI認証情報はリポジトリ外に保持し、ログへ出さない。
- Codex子プロセスへ渡す環境変数は実行・locale・Codex認証pathに必要な名前だけをallowlistし、OpenAI音声API keyや他サービスのsecretを継承しない。
- 認証元と隔離先が同一、隔離先がsymlink、`auth.json`が想定外のfile、または`config.toml`が空でない場合は既存fileを上書きせず起動を中止する。Windows Codex App側の`config.toml`、MCP、plugin、skillは隔離先へcopyもsymlinkもしない。
- Textチャンネルのメッセージは操作承認には使わない。停止はプロセス停止または管理者によるVoice切断で行う。
- 文字起こし、Codex応答、エラー概要は指定Textチャンネルへだけ送る。音声原本はディスクへ保存しない。
- STTやSDKの生error messageはDiscordにも構造化ログにも出さず、固定の利用者向け文言と内部error codeだけを使う。
- TTS音声がAI生成であることを起動メッセージで明示する。

## ターン状態

通常ターンは`idle → receiving → transcribing → posting_transcript → running_codex → posting_response → synthesizing → speaking → idle`で処理する。

会議観測モードは`receiving → parallel_transcribing → editing_live_transcript`を継続し、既定では文字起こし完了直後（無効時は定期的）に`observing → updating_minutes → optional_posting_response → optional_synthesizing → optional_speaking`を実行する。重なった発話は次の観測へまとめ、定期観測は取りこぼし防止として残す。Power taskは`creating_discord_thread → queued → running_in_separate_thread → streaming_curated_progress → posting_result → completed | failed | cancelled`として独立に進む。

各発話は一意なturn IDを持つ。状態遷移、処理時間、失敗段階だけを構造化ログへ残し、音声バイト列や認証情報は残さない。Codex thread IDはローカル状態ファイルへ保存し、再起動後にresumeする。明示的なreset時だけ新規threadを開始する。

停止要求はどの処理段階からも`stopped`へ遷移する。進行中stageへAbortSignalを伝え、依存処理がsignalを無視してもsession側の待機を解除し、未処理queueを破棄して新しい音声を受け付けない。

## 音声契約

- Discord受信: Opus 48kHz stereoをPCMへdecodeし、無音1,000msを発話終端とする。
- STT入力: PCMを16-bit 48kHz stereo WAVへ包み、最大90秒・25MB未満に制限する。短すぎる発話は破棄する。
- TTS出力: 指定速度（0.25〜4倍、既定1倍）の24kHz mono signed 16-bit little-endian PCMを48kHz stereoへ決定的に変換し、Discordへ再生する。
- Discord client、Voice connection、受信stream、再生playerの`error`はプロセスへ伝播させず、秘密を含まないerror種別だけを構造化ログへ残す。
- Decode後のPCMが不完全なsample frameでもプロセスを落とさず、その発話だけを破棄して固定文で再入力を案内する。
- 応答本文が長い場合、Textには全文を分割投稿し、音声は先頭1,200文字までを自然な区切りで読む。
- 防御的上限として文字起こしは8,000文字、Codex応答は12,000文字までを扱い、それ以上は省略を明示する。

## 受入条件

1. 既定モードではallowlist外ユーザーの音声を無視し、全参加者モードでは別ユーザーの音声もSTTとCodexへ渡る。
2. 無音・短音声・90秒超過・queue過多を安全に処理し、常駐プロセスが落ちない。
3. 同じsession内の連続発話が同じCodex threadへ渡る。
4. 文字起こし、Codex応答、TTSが順番どおりに一度ずつ呼ばれる。
5. PCM変換とWAV headerを単体テストで検証する。
6. 依存サービスをmockした統合テストで、成功・STT失敗・Codex失敗を検証する。
7. 設定検査は秘密値を表示せず、不足項目と対象IDだけを報告する。
8. lint、format、coverage、auditを含む既存`npm run verify`を通す。
9. Codex childに任意のprocess環境変数が漏れず、thread optionsでnetworkとWeb検索が無効になる。
10. timeoutは対応するAbortSignalを発火し、生errorやsecretらしい値をDiscord・ログへ含めない。
11. Windows側Codex homeにCLIが解釈できないMCP設定があってもそれを読まず、隔離先の空configとMCP 0件でCLIおよびSDKのsmokeが通る。
12. Voice接続や起動通知に失敗した場合は、途中生成したVoice connectionとログイン済みBot clientを必ず破棄する。通常停止は複数回呼んでも1回だけ後始末する。
13. SIGINT／SIGTERM時は進行中stageをcancelし、未処理queueを破棄して、依存処理の最大timeoutを待たず停止できる。
14. オフライン設定診断はBot資格情報、OpenAI API key、Codex認証を読まず、公開設定と作業ディレクトリだけを検査できる。
15. モック縦断は合成PCMの受信からWAV化、STT、Codex、Text投稿、TTS、Voice再生までを通し、外部呼び出しが0件であることを検証する。
16. 設定診断の失敗は安定したcode、固定message、具体的なactionで報告し、生error、Bot token、OpenAI API keyを含めない。
17. Setup doctorはNode runtime、offline公開設定、mock縦断、Codex isolation smokeを一つのJSONで診断し、外部呼び出し0件を明示する。
18. 実接続前checklistは、秘密値不要のローカル確認、資格情報設定後の完全診断、本人が行う一回限りのDiscord接続確認を分離する。
19. 検証記録fileは実行日、対象commit、各コマンドの結果、未実施の外部操作を秘密値・個人ID・端末固有パスなしで固定する。
20. Setup doctorは公開設定またはローカルsmokeの失敗時に非0終了し、生stderrや資格情報をJSON・ログへ転載しない。
21. 会議観測モードでは複数話者のSTTが並列に進み、観測時に話者名付きで一つの入力へまとめられる。
22. 応答不要と判断した観測では議事録だけを更新し、Discord応答とTTSを実行しない。
23. ライブ文字起こしと累積議事録はそれぞれ同じBotメッセージを編集し、発話ごとの新規メッセージを増やさない。
24. Powerモードでも他参加者だけの依頼、または本人と他参加者のsequenceが混在する依頼はtask queueへ入れない。
25. Power taskは会議観測threadと別に実行し、ファイル操作、network、live Web検索を利用できる。
26. Power taskの親メッセージは状態と専用スレッドへのリンクを表示し、開始・完了・失敗・中止に合わせて同じメッセージを更新する。
27. Power taskの依頼、要約済み進捗、結果、所要時間は専用スレッドへ時系列で投稿し、コマンドの生出力、秘密値、生errorは投稿しない。

## 第2段階

- Realtime transcriptionによるpartial transcriptと低遅延応答。
- Realtime APIを用いた発話途中からの応答開始。
- 明示的な危険操作approval UIと操作別policy。
- エージェントごとの別Codex資格情報、別ホスト実行、割り込み発話。

## 起動前診断

最初に`npm run inspect:discord:voice:offline`で、秘密値やCodex認証を読まずに公開ID、作業ディレクトリ、制限値を検査する。次に`npm run smoke:discord:voice:mock`で、合成PCMを使ったVoice受信からText/TTS再生までの縦断を外部接続0件で検証する。

`npm run doctor:discord:voice`は上記offline診断、mock縦断、隔離Codexのlocal smokeを連続実行し、`ready`、`checks`、`issues`、`externalCalls`をJSONでまとめる。doctor自体は`.env`を読み込まず、公開設定はshellへexportして渡す。出力の`ready: true`だけを実接続前のローカルゲートとして扱い、JSONを共有するときはcode・message・actionだけを抜粋する。

資格情報を設定した後だけ`npm run inspect:discord:voice`でBot資格情報、OpenAI API key、隔離`CODEX_HOME`を含む完全診断を行う。`npm run smoke:discord:voice:local -- /path/to/codex-home`は外部接続なしで、`auth.json`だけの隔離、空config、MCP 0件、Voice pipelineを検証する。`npm run smoke:discord:voice:codex -- /path/to/workspace`はDiscordや音声APIへ接続せず、Codex SDK認証だけをread-only threadで検証する。Windows Codex Appで既にサインイン済みなら、WSLから見えるWindows側`.codex`を`PERSONAL_CONTEXT_VOICE_CODEX_HOME`へ設定して同じ認証を使う。元の`config.toml`は読み込まれない。失敗時は[診断ガイド](./discord-voice-troubleshooting.md)に従う。

## 根拠

- OpenAI Codex SDK: https://learn.chatgpt.com/docs/codex-sdk
- OpenAI Speech to text: https://developers.openai.com/api/docs/guides/speech-to-text
- OpenAI Text to speech: https://developers.openai.com/api/docs/guides/text-to-speech
- Discord Voice connections: https://docs.discord.com/developers/topics/voice-connections
