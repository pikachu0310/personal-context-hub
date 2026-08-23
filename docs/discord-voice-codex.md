# Discord音声Codex MVP仕様

## 目的

本人がDiscordの専用Voiceチャンネルから日本語でCodexへ依頼し、文字起こし、ローカルCodex実行、読み上げまでを一つのターンとして完結できるようにする。Discordのユーザーアカウントを自動操作せず、既存の専用Bot資格情報だけを使う。

## MVPの境界

- 1 Guild、1 Voiceチャンネル、1 Textチャンネル、1本人ユーザーを環境変数でallowlistする。
- Botは起動時に指定Voiceチャンネルへ参加する。本人以外の音声は購読しない。
- 発話終了後に音声を一つのWAVへ変換し、OpenAI Transcriptions APIの`gpt-transcribe`へ送る。
- 確定した文字起こしを同じTextチャンネルへ記録してから、`@openai/codex-sdk`の同一ローカルthreadへ渡す。
- Codexの最終応答をTextチャンネルへ分割投稿し、`gpt-4o-mini-tts`で生成したPCMをVoiceへ返す。
- 同時発話は直列queueに積み、再生中も受信する。1ターンの失敗は次のターンを止めない。
- 作業ディレクトリ、sandbox、モデルは明示設定する。既定sandboxは`workspace-write`とし、任意ディレクトリへの無制限書き込みを暗黙に許可しない。

## 信頼境界

- Discord上の発話は外部入力である。発話者IDが本人allowlistと一致する場合だけCodex入力として扱う。
- Bot tokenとOpenAI認証情報はリポジトリ外に保持し、ログへ出さない。
- Textチャンネルのメッセージは操作承認には使わない。停止はプロセス停止または管理者によるVoice切断で行う。
- 文字起こし、Codex応答、エラー概要は指定Textチャンネルへだけ送る。音声原本はディスクへ保存しない。
- TTS音声がAI生成であることを起動メッセージで明示する。

## ターン状態

`idle → receiving → transcribing → running_codex → speaking → idle`

各発話は一意なturn IDを持つ。状態遷移、処理時間、失敗段階だけを構造化ログへ残し、音声バイト列や認証情報は残さない。Codex thread IDはローカル状態ファイルへ保存し、再起動後にresumeする。明示的なreset時だけ新規threadを開始する。

## 音声契約

- Discord受信: Opus 48kHz stereoをPCMへdecodeし、無音1,000msを発話終端とする。
- STT入力: PCMを16-bit 48kHz stereo WAVへ包み、最大90秒・25MB未満に制限する。短すぎる発話は破棄する。
- TTS出力: 24kHz mono signed 16-bit little-endian PCMを48kHz stereoへ決定的に変換し、Discordへ再生する。
- 応答本文が長い場合、Textには全文を分割投稿し、音声は先頭1,200文字までを自然な区切りで読む。

## 受入条件

1. allowlist外ユーザーの音声はSTTにもCodexにも渡らない。
2. 無音・短音声・90秒超過・queue過多を安全に処理し、常駐プロセスが落ちない。
3. 同じsession内の連続発話が同じCodex threadへ渡る。
4. 文字起こし、Codex応答、TTSが順番どおりに一度ずつ呼ばれる。
5. PCM変換とWAV headerを単体テストで検証する。
6. 依存サービスをmockした統合テストで、成功・STT失敗・Codex失敗を検証する。
7. 設定検査は秘密値を表示せず、不足項目と対象IDだけを報告する。
8. lint、format、coverage、auditを含む既存`npm run verify`を通す。

## 第2段階

- Realtime transcriptionによるpartial transcriptと低遅延応答。
- Discord slash commandによるjoin/leave/reset/status。
- 明示的な危険操作approval UIと操作別policy。
- 複数利用者・複数workspace・割り込み発話。

## 起動前診断

`npm run inspect:discord:voice`で、Bot資格情報、必須環境変数、Codex作業ディレクトリを秘密値なしで検査する。`npm run smoke:discord:voice:codex -- /path/to/workspace`はDiscordや音声APIへ接続せず、WSL側のCodex SDK認証だけをread-only threadで検証する。`Your access token could not be refreshed`の場合は、Windows Codex Appとは別にWSL内で`npx codex login --device-auth`を実行して再認証する。

## 根拠

- OpenAI Codex SDK: https://developers.openai.com/codex/sdk/
- OpenAI Speech to text: https://developers.openai.com/api/docs/guides/speech-to-text
- OpenAI Text to speech: https://developers.openai.com/api/docs/guides/text-to-speech
- Discord Voice connections: https://docs.discord.com/developers/topics/voice-connections
