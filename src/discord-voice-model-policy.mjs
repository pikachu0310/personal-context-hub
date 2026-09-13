export const DEFAULT_VOICE_CODEX_MODEL = "gpt-5.6-sol";
export const DEFAULT_VOICE_REASONING = "low";

export function isAstra(model) {
  return /(?:^|[-_])astra(?:$|[-_])/i.test(String(model ?? ""));
}

// Automatic routing must never turn task complexity or an old profile into
// permission to spend on Astra. Only a participant's explicit model selection
// accompanies an individual task or follow-up.
export function automaticVoiceModel(model) {
  return !model || isAstra(model) ? DEFAULT_VOICE_CODEX_MODEL : model;
}

export function requestedVoiceModel(text) {
  const content = String(text ?? "")
    .replace(
      /```[\s\S]*?```|`[^`]*`|「[^」]*」|『[^』]*』|“[^”]*”|"[^"\n]*"/gu,
      " ",
    )
    .replace(/^\s*>.*$/gmu, " ");
  // A model mention, a comparison question, a quote, and a negated request are
  // not a selection. Require a positive, direct model-choice construction.
  if (
    /(?:astra|アストラ)[^。\n]{0,40}(?:使わ|使用しな|利用しな|しない|禁止|不要|以外|(?:使って|使用して|利用して)(?:は|も)?(?:いけない|駄目|だめ|ダメ))|(?:使うな|使わないで)[^。\n]{0,12}(?:astra|アストラ)/iu.test(
      content,
    )
  )
    return {
      model: DEFAULT_VOICE_CODEX_MODEL,
      reasoningEffort: "low",
      explicit: true,
    };
  if (
    /(?:Sol|ソル)(?:\s*low|ロー)?(?:で|を使って|を使用して|に戻して|にして)|(?:モデル[はを:]\s*|use\s+)(?:gpt-5\.6-)?sol\b/iu.test(
      content,
    )
  )
    return {
      model: DEFAULT_VOICE_CODEX_MODEL,
      reasoningEffort: "low",
      explicit: true,
    };
  if (
    /[?？]|(?:使っている|使用している|している|という|と言|かどうか|できる|使うと)/u.test(
      content,
    )
  )
    return undefined;
  if (
    content
      .split(/[。\n]/u)
      .some((sentence) =>
        /(?:Astra|アストラ)(?:\s*(?:high|ハイ))?(?:(?:で|を使って|を使用して)[^?？]{0,40}(?:お願い(?:します)?|(?:実装|調査|検証|確認|修正)して|考えて|やって|進めて|直して|作って)(?:ください)?|を使って|を使用して|にして)[.!！\s]*$|(?:モデル[はを:：]\s*|use\s+)(?:gpt-6-)?astra(?:\s+for\s+(?:this|the)\s+task)?[.!！\s]*$/iu.test(
          sentence,
        ),
      )
  )
    return { model: "gpt-6-astra", reasoningEffort: "high", explicit: true };
  return undefined;
}

export function taskModelSelection(task) {
  const selection = task.modelSelection;
  if (
    selection?.explicit === true &&
    [DEFAULT_VOICE_CODEX_MODEL, "gpt-6-astra"].includes(selection.model)
  )
    return selection;
  return undefined;
}
