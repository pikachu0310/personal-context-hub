import type { PluginEvent } from "../../../common/src/contracts/plugins.js";
interface Meeting {
  summary: string;
  messages: Array<{
    text: string;
    authorId: string;
    authorName?: string;
    at: number;
  }>;
}
export function renderPublication(event: PluginEvent) {
  const meeting = event.data as Meeting;
  if (event.type === "minutes")
    return "📝 議事録\n" + (meeting.summary || "集計中です。");
  return (
    "🎙 ライブ文字起こし（直近の発言）\n" +
    meeting.messages
      .slice(-12)
      .map(
        (m) =>
          `${new Date(m.at).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo" })} ${m.authorName ?? m.authorId}: ${m.text}`,
      )
      .join("\n")
      .slice(-1750)
  );
}
