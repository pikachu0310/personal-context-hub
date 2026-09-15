# IDOエンジン 提出文と利用素材の説明

チーム：結論、めっちゃ開発（H156）

## 提出用の説明

IDOエンジンは、会話から試作を進めるチーム向けAIエージェントです。
話した内容をAIに説明し直し、完成後に集まって感想を伝える往復を減らし、会議の中で実物を触って判断できる状態を目指します。
会話を話者付きで記録し、議題ごとに整理。作業するCodexは議事録と元の発言を検索できます。
デモでは、ワープ移動と連続移動を同じコースで比較する試作を生成し、同じタスクで初期速度を1.00から0.50へ変更。さらに、光る目標を3つ集めるチャレンジを追加しています。
プレビューから感想を返し、新しい版を開いて、修正前後を触って比べられます。
現在の入口はDiscordとブラウザ。ゲーム企画やUI案の比較など、話しながら試すチーム作業への再利用を目指しています。

## 動画について

- 1分57秒。1280×720、24fps、H.264 / AACのMP4。
- 準備済みの会話と制作条件を使った実システムの動作収録です。参加者A・Bはデモ用の話者です。
- 今回1回の記録は、初回試作が約4分44秒、修正が約1分32秒です。実利用での時間短縮は未測定です。
- 会議記録・修正履歴・修正到着・過去版比較は実システムの収録です。一部の試作操作と会話表示は撮影用に再構成し、動画内で明示しています。速度1.0/0.5の補助映像は同じ試作のパラメータ切替です。
- 日本語ナレーションはOpenAIのAI音声（gpt-4o-mini-tts、coral）。焼き込み字幕とSRTを付属しています。
- 本編はブラウザ上の試作です。107–111秒には同チームのVRChat連携試作を収録しています。Unity ClientSim内のUdonからlocalhostへGETし、固定サンプルの返答を表示したもので、AI実応答・本番VRChat完成・VR機器での快適性を示しません。
- 定量的な開発時間の短縮、複数PC同時実行、Slack・VRChat連携を、この動画で検証済みとは主張していません。

## 既存コードと当日の開発

9月15日09:00以前から、IDOエンジンの会話処理、Engine / Client、Discord連携、Codex実行などの基盤コードが存在します。
本体のpackage.jsonのライセンス表記はUNLICENSEDです。オープンソースとして公開済みの製品とは説明していません。

当日の変更として、以下を実装履歴から確認しています。

| 当日の変更 | 根拠となるリビジョン |
| --- | --- |
| 議事録での合意・検討の区別 | 76d90ae |
| 試作を開き、同じタスクへ修正を依頼する体験 | be57d37 |
| main2への会話機能の接続 | c2a47bf |
| チャンネル設定の整備 | ef0ae25 |
| 修正前後の版比較・展示表示 | 1346767 |

映像中の比較試作も9月15日にデモ用の会話からCodexが作成し、追加依頼で修正しています。
制作の基準リビジョンは `134676793e94288626ab125f38d41d442497112d` です。

## 第三者の技術・素材

製品の依存関係は基準リビジョンのpackage.json / package-lock.jsonで確認しています。
主要な直接依存とライセンスは次のとおりです。各依存の推移的依存と正確なバージョンはpackage-lock.jsonに記録されています。

| 技術 | 利用とライセンス |
| --- | --- |
| Codex CLI、OpenAI JavaScript SDK | Apache-2.0。実装エージェントとAPI接続 |
| OpenAI API | 会話処理、音声認識、音声合成。OpenAIのサービス利用条件に従う |
| Discord.js、@discordjs/voice、prism-media | Apache-2.0。Discordと音声の接続 |
| React / React DOM、Mantine、Vite、ws、zod | MIT。画面と通信、データ処理 |
| CodeMirror、Lezer、react-markdown、remark-gfm | MIT。エディタ・文章表示 |
| Tabler Icons、@discord/embedded-app-sdk、opusscript | MIT。アイコン・Discord画面・音声処理 |
| Noto Sans JP / Fontsource | OFL-1.1。製品画面と提出資料の日本語フォント |
| Electron、electron-builder | MIT。デスクトップ版の構成。今回の映像はブラウザで収録 |
| TypeScript、Playwright | Apache-2.0。開発用依存 |
| ESLint、esbuild、Prettier、tsx、型定義、globals、js-yaml、picomatch | MIT。開発用依存 |
| Claude Agent SDK | package-lockは「SEE LICENSE IN README.md」。任意バックエンド用依存。映像のタスク実行では使用していない |

動画・資料はCodex、Codex同梱Artifact Tool、Python/Pillow、FFmpegを使って制作しています。
PillowはHPND系ライセンス、使用したFFmpegビルドはGPLv3です。これらの実行ファイルは提出物に同梱しません。
外部の写真、音楽、第三者データセットは使用していません。画面素材はIDOエンジン、生成した試作、同チームが制作した撮影用表示、Unity/ClientSimの試作から収録しています。
Unityは[Unity Editor Software Terms](https://unity.com/legal/editor-terms-of-service/software)、VRChat SDK/Udon/ClientSimは[VRChat SDK License](https://hello.vrchat.com/legal/sdk)および各配布物に同梱された条件に従って使用します。SDKの実行ファイルは提出物に同梱しません。

## 発表と提出

[当日の公式案内](https://codex-hackathon-20260915.openai.chatgpt.site/)では、概要1枚と2分以内の動画、9月15日15:15締切を確認しています。
[公式ルール](https://codex-student-hack-fes.openai.chatgpt.site/official-rules/)は、一次審査がCodex活用・実社会へのインパクト・再利用可能性・デモとピッチの各20%と参加者投票の考慮20%、最終審査が4項目各25%です。
同点時はCodex活用、次にインパクトが優先されます。

提出用の1枚は[公式テンプレートを使ったGoogle Slides](https://docs.google.com/presentation/d/1DR1OJDGeKmsxOZfpR18xb1ltxzrdUBJI4WGPia9ltfw/edit)、動画は `ido-demo.mp4` です。
Google Slidesの右側に117秒のDrive動画を埋め込み、ブラウザで実再生を確認しました。正式な大会共有資料には提出していません。Google SlidesとDrive動画は現在非公開です。提出時には両方の閲覧権限を合わせてください。
`ido-overview-final.pptx` はテンプレート判明前の参考稿です。提出用はGoogle Slidesと、その書き出し `ido-submission-template` を使用します。
`ido-pitch-final.pptx` は最終発表に備えた6枚の補助資料で、スピーカーノートに4分の時間配分と発表原稿を入れています。
`ido-submission-template.pptx` は文字を編集でき、動画プレビュー画像から公開MP4を開く書き出しです。スライド内の再生はGoogle Slides版を使用します。PDFとPNGは静止版です。Googleの静止書き出しで取得できなかった動画サムネイルには、実動画のポスターを補っています。

[公開デモ](https://ido-engine-demo.pikachu0310.chatgpt.site)はT094が公開・操作確認を完了し、最新117秒動画へ更新済みです。この制作では稼働Botの変更・再起動を行っていません。

## 制作の再実行

製品リポジトリの `submission/2026-09-15` に台本と生成スクリプトを保存しています。
Windowsの作業用フォルダーへ、スクリプトとcontent.jsonを `build`、収録素材と音声を `assets`、完成物を `output` に配置して実行します。
提出用1枚はGoogle Slidesの公式テンプレートをコピーして編集しています。最終の構成と文字・配置はtemplate-plan.jsonに保存しています。動画はPillowとimageio-ffmpegがあるPythonを使用します。
生成物はリポジトリの `.ido-build/hackathon` に保存し、Gitの対象から外しています。収録素材は制作環境のassetsを使用します。
この制作で、実行時DB・会話の生ログ・認証情報をGitへ追加していません。
