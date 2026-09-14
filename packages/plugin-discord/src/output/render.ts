import type { PluginEvent } from "@ido/common/contracts/plugins";
import type { MeetingKnowledge } from "@ido/common/contracts/knowledge";
interface Meeting {
  projectId?: string;
  projectName?: string;
  knowledge?: MeetingKnowledge;
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
  if (event.type === "minutes") {
    if (!meeting.knowledge?.topics.length)
      return (
        "📝 議事録\n" +
        (meeting.summary || "議題を整理しています。").slice(0, 1800)
      );
    const topics = [...meeting.knowledge.topics].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const lines = ["📝 議事録（最近更新した議題）"];
    for (const topic of topics) {
      const block = [
        `\n**${topic.title.slice(0, 80)}**`,
        topic.summary.slice(0, 260),
        ...topic.decisions
          .slice(0, 2)
          .map((text) => `決定: ${text.slice(0, 120)}`),
        ...topic.openQuestions
          .slice(0, 2)
          .map((text) => `未決: ${text.slice(0, 120)}`),
        `根拠: ${topic.sourceIds.length}発言`,
      ].join("\n");
      if (lines.join("\n").length + block.length > 1750) break;
      lines.push(block);
    }
    lines.push(
      "\n全議題と元の発言はActivity・Clientの議事録から確認できます。",
    );
    return lines.join("\n");
  }
  return (
    "🎙 ライブ文字起こし（直近の発言）\n" +
    `現在のプロジェクト: ${(meeting.projectName ?? meeting.projectId ?? "未設定").replace(/[\r\n]/g, " ").slice(0, 100)}\n\n` +
    meeting.messages
      .slice(-12)
      .map(
        (m) =>
          `${new Date(m.at).toLocaleTimeString("ja-JP", { timeZone: "Asia/Tokyo" })} ${m.authorName ?? m.authorId}: ${m.text}`,
      )
      .join("\n")
      .slice(-1700)
  );
}
