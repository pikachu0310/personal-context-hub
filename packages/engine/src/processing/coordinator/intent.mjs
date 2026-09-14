import {
  parseBotInvocation,
  invocationAcknowledgement,
} from "../immediate/invocation.mjs";
const QUOTED = /「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`]*`/gu;

const isBotAddressed = (text) => Boolean(parseBotInvocation(text));
function uncertain(text) {
  return /(?:まだ|あとで|後で|今は|今回は).{0,24}(?:不要|しない|やらない|待|保留|決め|決ま|検討)|(?:しなくて|やらなくて|始めなくて)(?:いい|よい)|(?:かも|かな[。？?\s]*$|どうしよう|検討中|未定|未決定|決まってない|決まっていない|やめよう|保留|見送|必要なら|もし|としたら|したほうが|してもいい|するとしたら)/u.test(
    text,
  );
}

export function explicitDelegation(text, { explicitlyAsked = false } = {}) {
  if (explicitlyAsked && !isBotAddressed(text))
    return explicitDelegation(`井戸Bot、${text}`);
  const unquoted = String(text ?? "")
    .replace(QUOTED, "")
    .trim();
  if (!unquoted || uncertain(unquoted) || invocationAcknowledgement(unquoted))
    return false;
  if (isBotAddressed(unquoted))
    return (
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
