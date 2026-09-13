# Discord音声Codex 検証記録

この記録は、日付ごとの検証範囲と未確認事項を残す。credential、個人ID、端末固有path、raw stderr、音声原本は記録しない。

## 2026-09-13: 音声対話と試用・訂正ループ

実装の基準は `9b1b38e`。通常のCodexはSol low、Astraは作業ごとの明示指定だけで使用する。GPT-Liveは既定では無効とし、30分の比較セッションとして有効にできる。

| 検証              | 結果                                             | 確認できる範囲                                                                                  |
| ----------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| `npm run verify`  | 271テスト通過、coverage閾値通過、audit 0件       | 構文・lint・整形・自動テスト                                                                    |
| GitHub CI         | `9b1b38e` 成功                                   | pushした同一commitの検証                                                                        |
| 実Codex＋ブラウザ | 最初の版まで約22秒、訂正後の再試用まで合計約36秒 | 小さなボタンfixtureをSol lowで変更し、Chromiumでクリック・表示・サイズを確認。旧URLの停止も確認 |
| 会議観測の実Codex | 約7秒で根拠発言を伴う訂正を取得                  | 分離した検証環境でのSol lowの構造化出力                                                         |
| GPT-Live実API     | 合成音声入力、client delegation、音声出力を確認  | 音声transportの接続。Discord・人の会話品質は含まない                                            |

上記の秒数はfixtureでの観測値であり、一般の開発所要時間を保証しない。初回のCodex試行で得たusageは最後の応答分であり、ターン全体の費用として使わない。実装では取得できた累積usageの差分を記録し、範囲が限定される場合は明示する。

続く検証では、観測中の訂正、受領待ちに重なった追加訂正、プレビュー停止とサービス終了の同時処理を追加確認し、全274テストが通過した。プレビュー単体のsmokeも専用の一時Codex設定で2版のブラウザ操作と旧URL停止を再確認した。ブラウザの実行ファイルが標準の場所にない環境では `PERSONAL_CONTEXT_VOICE_PREVIEW_BROWSER_EXECUTABLE` の指定が必要になる。

4人の実通話、別端末での同一版の試用、従来STT/TTSとGPT-Liveの聞き取り・割り込み・誤発話の比較は未確認。自動操作の成功と人の試用報告は別に表示する。

以下は過去の記録であり、現在の接続可否を表すものではない。

## 記録

- 実行日: 2026-08-24
- 対象branch: `codex/discord-voice-codex`
- 基準commit: `e447a0c`
- cycle 3実装commit: `a0bc53d`
- cycle 3文書commit: `379aae6`
- cycle 4 doctor実装commit: `70ec36b`
- cycle 4外部操作: Discord接続・Discord送信・credential入力・pushを実施していない

## 結果

| 検証              | コマンド                                        | 結果                                                        |
| ----------------- | ----------------------------------------------- | ----------------------------------------------------------- |
| offline設定       | `npm run inspect:discord:voice:offline`         | `ready: true`、credential／API key／Codex isolationはskip   |
| mock縦断          | `npm run smoke:discord:voice:mock`              | `VOICE_CODEX_MOCK_E2E_OK`、`externalCalls: 0`               |
| Codex isolation   | `npm run smoke:discord:voice:local`             | `VOICE_CODEX_LOCAL_OK`、MCP 0件、`externalCalls: 0`         |
| setup doctor      | `npm run doctor:discord:voice`                  | `VOICE_CODEX_DOCTOR_OK`、全check passed、`externalCalls: 0` |
| repository verify | `npm run verify`                                | 75 tests passed、coverage閾値通過、audit 0 vulnerabilities  |
| secret／path scan | 変更fileのcredential・端末固有path pattern scan | 一致なし                                                    |

## 判定

ローカルゲートは完了した。実Discord接続、実STT／TTS、実Codex SDK認証の確認は未実施であり、[実接続前checklist](./discord-voice-preflight-checklist.md)の本人操作待ちである。
