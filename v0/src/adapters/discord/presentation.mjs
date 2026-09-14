import { createPresentation } from "../../engine/output/presentation.mjs";
import { boundText, safeSliceEnd } from "../../engine/shared.mjs";
import { speakerLabel } from "../../engine/observation/observation.mjs";
const MAX_DISCORD_MESSAGE = 1_900;
const MAX_LIVE_TRANSCRIPT_CHARACTERS = 1_850;
export function splitDiscordText(text, maximum = MAX_DISCORD_MESSAGE) {
  const normalized = String(text ?? "").trim();
  if (!normalized) return [];
  if (!Number.isInteger(maximum) || maximum < 2) return [normalized];
  const chunks = [];
  let remaining = normalized;
  while (remaining.length > maximum) {
    let cut = remaining.lastIndexOf("\n", maximum - 1);
    if (cut < maximum * 0.5) cut = remaining.lastIndexOf("。", maximum - 1);
    if (cut < maximum * 0.5) cut = remaining.lastIndexOf(" ", maximum - 1);
    if (cut < maximum * 0.5) cut = maximum;
    else cut += 1;
    cut = safeSliceEnd(remaining, cut);
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

export function escapeDiscordMarkdown(value) {
  return String(value ?? "").replace(/([\\`*_{}[\]()#+.!|>~-])/g, "\\$1");
}

export function formatMeetingTranscript(
  statements,
  maximum = MAX_LIVE_TRANSCRIPT_CHARACTERS,
) {
  const ordered = [...statements].sort(
    (left, right) =>
      (left.startedAt ?? 0) - (right.startedAt ?? 0) ||
      (left.sequence ?? 0) - (right.sequence ?? 0),
  );
  const lines = ordered.map(
    (statement) =>
      `**${escapeDiscordMarkdown(speakerLabel(statement))}**: ${statement.text}`,
  );
  const header = "🎙️ **会話ログ・処理状況**";
  const omittedNotice = (count) =>
    `_表示を省略した発話 ${count} 件があります。_\n`;
  const bodyLimit = Math.max(
    0,
    maximum -
      header.length -
      1 -
      (lines.length > 1 ? omittedNotice(lines.length).length : 0),
  );
  const kept = [];
  let used = 0;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (used + line.length + (kept.length ? 1 : 0) > bodyLimit) {
      if (!kept.length) kept.push(boundText(line, bodyLimit));
      break;
    }
    kept.unshift(line);
    used += line.length + (kept.length > 1 ? 1 : 0);
  }
  const omitted = lines.length - kept.length;
  const body = kept.length ? kept.join("\n") : "_発話を待っています。_";
  return boundText(
    `${header}\n${omitted ? omittedNotice(omitted) : ""}${body}`,
    maximum,
  );
}

export const discordPresentation = {
  ...createPresentation({
    bold: (text) => `**${text}**`,
    code: (text) => `\`${text}\``,
    italic: (text) => `_${text}_`,
    escape: escapeDiscordMarkdown,
    reference: (id) => (id ? ` <#${id}>` : ""),
    statusHelp: "全件とIDは /ido status で確認できます。",
    stopHelp: "IDは /ido status で確認し、/ido stop タスクID で停止できます。",
    receiptHelp: (id) => `/ido status で確認、/ido stop ${id} で取り消せます。`,
    contextHelp: "全文: /ido context",
  }),
  splitText: splitDiscordText,
  escapeText: escapeDiscordMarkdown,
  formatTranscript: formatMeetingTranscript,
  maximumText: 1900,
  maximumTranscript: 1850,
};
