// Keep ASR aliases bounded to direct vocatives, never substring mentions.
const NAME =
  "(?:井戸(?:bot|ボット)|[いイ][どド](?:ぼっと|ボット|ポット)|移動ボット|コーデックス(?:ボット)?|codex(?:[ ]+bot)?)";
const SEPARATOR = "[、,：:。.!！?？\\s]*";
const PREFIX =
  "(?:(?:あ[ーあ]*|え[ーえ]*と?|えっと|あの|ねえ|ねぇ|ちょっと|すみません|こんにちは|もしもし)[、,\\s]+){0,6}";
const VOCATIVE = new RegExp(
  `^${PREFIX}(${NAME})(?=$|[、,：:。.!！?？\\s]|教えて|聞いて|お願い|調べて|確認して|答えて|何か|停止|止めて)${SEPARATOR}`,
  "iu",
);
const MENTION =
  /^(?:って|という|と呼|と言|と聞|の(?:応答|認識|名前|こと|動作)|は(?:今|どう|まだ)|をどう|が(?:反応|応答))/u;
const QUOTED = /「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`]*`/gu;

export function parseBotInvocation(value) {
  const text = String(value ?? "")
    .normalize("NFKC")
    .trim();
  // Mask quoted calls so a full stop inside a quotation cannot create a call.
  const masked = text.replace(QUOTED, (quote) => "＿".repeat(quote.length));
  if (/[「」『』"`]/u.test(masked)) return undefined;
  const starts = [
    0,
    ...Array.from(
      masked.matchAll(/[。.!！?？\n]+/gu),
      (m) => m.index + m[0].length,
    ),
  ];
  for (const start of starts) {
    const candidate = masked.slice(start).trimStart();
    const call = candidate.match(VOCATIVE);
    if (!call) continue;
    let body = candidate.slice(call[0].length).trim();
    let repeated = body.match(VOCATIVE);
    while (repeated) {
      body = body.slice(repeated[0].length).trim();
      repeated = body.match(VOCATIVE);
    }
    if (
      MENTION.test(body) ||
      /(?:って|と)(?:言った|言って|書いた|書いて|呼んだ|呼んで)/u.test(body)
    )
      continue;
    // Return original quoted content in the request; masking is only for detection.
    const offset = masked.length - body.length;
    return { name: call[1], body: text.slice(offset).trim() };
  }
  return undefined;
}

export function invocationAcknowledgement(text) {
  const call = parseBotInvocation(text);
  if (!call) return undefined;
  const body = call.body.replace(/[。.!！?？\s]+$/gu, "");
  if (
    !body ||
    /^(?:こんにちは|もしもし|返事して|返事をして|応答して|応答せよ|答えて|何か(?:喋って|しゃべって|話して))(?:ください|くれる|くれますか)?$/u.test(
      body,
    )
  )
    return "はい、聞いています。";
  if (
    /^(?:(?:今|ちゃんと|こちらの声|声|音声)(?:は|が|を)?[、,\s]*)*(?:聞こえて(?:る|いる|ます|います)|聞いてる)(?:か|かな)?$/u.test(
      body,
    )
  )
    return "はい、聞こえています。";
  return undefined;
}
