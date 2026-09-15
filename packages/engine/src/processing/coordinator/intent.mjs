import {
  parseBotInvocation,
  invocationAcknowledgement,
} from "../immediate/invocation.mjs";
const QUOTED = /「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`]*`/gu;

const isBotAddressed = (text) => Boolean(parseBotInvocation(text));
const unquote = (text) =>
  String(text ?? "")
    .normalize("NFKC")
    .replace(QUOTED, "")
    .trim();
export function deferredDelegation(text) {
  if (
    /(?:した|する)(?:ほう|方)が(?:いい|よい)(?:か|かな)|する(?:べきか|かどうか)/u.test(
      unquote(text),
    )
  )
    return true;
  if (/(?:検討中|未定|未決定|決まってない|決まっていない)/u.test(unquote(text)))
    return true;
  return prohibitedDelegation(text);
}

export function prohibitedDelegation(text) {
  return /(?:まだ|あとで|後で|今は|今回は).{0,24}(?:不要|しない|やらない|待って|保留|決めてない|決まってない)|(?:しなくて|やらなくて|始めなくて)(?:いい|よい)|(?:しないで|やらないで|始めないで|作らないで)|(?:やめよう|実行禁止|保留|見送|自分でやる|自分で作る)/u.test(
    unquote(text),
  );
}

export function explicitDelegation(text, { explicitlyAsked = false } = {}) {
  if (explicitlyAsked && !isBotAddressed(text))
    return explicitDelegation(`井戸Bot、${text}`);
  const unquoted = unquote(text);
  if (
    !unquoted ||
    deferredDelegation(unquoted) ||
    invocationAcknowledgement(unquoted)
  )
    return false;
  if (isBotAddressed(unquoted))
    return (
      /(?:作って|作成して|作れる|作れます|直して|修正して|実装して|実装でき|調べて|調べられ|確認して|比較して|検証して|試して|進めて|実行して|お願い|任せる).{0,30}(?:くれるかな|もらえるかな|もらえないかな|くれない|ほしい|欲しい|ください|できる|できます|くれる|もらえる|もらえます|もらえません|お願い|頼む|任せる|いい)[。！!？?\s]*$/u.test(
        unquoted,
      ) ||
      /(?:作れる|作れます|実装できる|実装できます|調べられる|確認できる|試せる|比較できる|検証できる)(?:かな|か|でしょうか)?[。！!？?\s]*$/u.test(
        unquoted,
      ) ||
      /(?:して|してください|作って|直して|調べて|確認して|進めて|お願い|頼む|任せる|実行)(?:ほしい|ほしいです|くれる|くれますか|もらえる|もらえますか)?[。！!？?\s]*$|(?:して|作って|直して|調べて|進めて)ください/u.test(
        unquoted,
      ) ||
      /(?:タスク|[Ii]ssue|イシュー).{0,30}(?:立てて|建てて|切って)(?:ください|くれる|ほしい)?[。！!？?\s]*$/u.test(
        unquoted,
      )
    );
  return /(?:井戸(?:Bot|ボット)|ボット|Bot|Codex|コーデックス)(?:に|へ).{0,100}(?:任せよう|任せる|任せて|頼もう|頼む|依頼する|依頼しよう|お願いする|お願いしよう|やってもらおう|やってもらう|進めてもらおう|進めてもらう)[。！!\s]*$/iu.test(
    unquoted,
  );
}

/** A broad opportunity filter, not the decision maker. The model still needs a concrete useful result. */
export function proactiveOpportunity(text) {
  const value = unquote(text);
  if (
    value.length < 6 ||
    deferredDelegation(value) ||
    invocationAcknowledgement(value) ||
    /(?:と言って|と言った|という(?:依頼|文例)|引用|たとえば|例えば|もし.{0,30}なら)/u.test(
      value,
    )
  )
    return false;
  return /(?:モック|試作|プロトタイプ|検証|比較|調査|原因|遅延|性能|ベンチマーク|実装|ライブラリ|API|SDK|画面|機能|テスト|コード|接続|動くか|動かない|確認したい|確かめたい|調べたい|試したい|試してみたい|作りたい|作ってみたい|分からない|わからない|不明|知りたい)/iu.test(
    value,
  );
}

export function quotedOnly(text) {
  return !unquote(text).replace(/[。！!？?、,\s]/gu, "");
}
