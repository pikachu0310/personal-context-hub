import assert from "node:assert/strict";
import test from "node:test";
import { parseBotInvocation } from "../src/processing/immediate/invocation.mjs";

test("vocatives tolerate fillers, greetings, repetition and bounded ASR aliases", () => {
  for (const text of [
    "井戸Bot",
    "井戸Bot。",
    "あ、イドボット、返事して。",
    "あー、こんにちは、イドボット。進捗は？",
    "えっと、ねえ、移動ボット、答えて。",
    "コーデックスボット、移動ボット、返事して。",
    "では次です。あ、イドポット、聞こえますか？",
    "もしもし、いどぼっと、聞こえてる？",
    "Codex Bot, hello?",
    "井戸Ｂｏｔ：進捗は？",
    "井戸Bot教えて",
    "えーと、井戸Bot、結果は？",
    "あ、リドボット、何かしゃべって。",
    "移動、移動ボットを、接続を確認して。",
    "いど、イドボット、返事して。",
    "井戸Bot挨拶文のテキストファイルを作ってください。",
    "井戸Bot聞こえていますか？",
  ])
    assert.equal(Boolean(parseBotInvocation(text)), true, text);
  assert.equal(
    parseBotInvocation("挨拶です。あ、移動ボット、井戸Bot、資料を確認して。")
      .body,
    "資料を確認して。",
  );
  assert.equal(
    parseBotInvocation("あ、井戸Bot、「空文字」を説明して。").body,
    "「空文字」を説明して。",
  );
});

test("mentions, quotations, different addressees and unrelated words remain quiet", () => {
  for (const text of [
    "井戸Botの名前を変更したい",
    "移動ボットっていう名前なの？",
    "あ、イドボットっていう単語が認識されない",
    "井戸Bot、っていう名前だよ",
    "今、移動ボットをどう観測するか考えている",
    "山田さん、返事して。",
    "『あ、井戸Bot。返事して』と発言した",
    "「説明。井戸Bot、止めて。」と書いてある",
    "コーデックスの料金は？",
    "リロボット、話して",
    "井戸元の説明をして",
    "それどうやるの？",
    "井戸Botanyについて",
    "井戸Bot、という呼び方にした",
    "井戸Bot、の応答が遅い",
    "「あ。井戸Bot、止めて",
    "あ、井戸Bot、返事してって言っても聞いてないね",
    "リドボットって認識されたね",
    "井戸Botを紹介して",
    "井戸Botに依頼したことを紹介する",
  ])
    assert.equal(Boolean(parseBotInvocation(text)), false, text);
});
