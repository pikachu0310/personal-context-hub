function terms(text) {
  const words =
    String(text)
      .toLowerCase()
      .match(/[a-z0-9_-]{3,}|[\p{Script=Han}\p{Script=Katakana}]{2,}/gu) ?? [];
  return [
    ...new Set(
      words.flatMap((word) =>
        word.length > 5 && /\p{Script=Han}/u.test(word)
          ? Array.from({ length: word.length - 1 }, (_, i) =>
              word.slice(i, i + 2),
            )
          : [word],
      ),
    ),
  ].slice(0, 50);
}

// Decisions remain interpretations with embedded sources, not new authority.
export class MeetingMemory {
  constructor(snapshot = {}) {
    this.sources = structuredClone(snapshot.sources ?? []);
    this.decisions = structuredClone(snapshot.decisions ?? []);
    this.revision = snapshot.revision ?? 0;
  }
  remember(statement) {
    if (
      !statement.text ||
      this.sources.some(
        (source) =>
          source.sequence === statement.sequence &&
          source.meetingId === statement.meetingId,
      )
    )
      return;
    const {
      id,
      meetingId,
      sequence,
      userId,
      speakerName,
      startedAt,
      text,
      taskEligible,
    } = statement;
    this.sources.push({
      id,
      meetingId,
      sequence,
      userId,
      speakerName,
      startedAt,
      text: String(text).slice(0, 12000),
      taskEligible,
    });
    let size = this.sources.reduce(
      (total, source) => total + source.text.length,
      0,
    );
    while (this.sources.length > 200 || size > 120_000)
      size -= this.sources.shift().text.length;
  }
  update(decisions, statements) {
    const bySequence = new Map(
      statements.map((statement) => [statement.sequence, statement]),
    );
    for (const decision of (Array.isArray(decisions) ? decisions : []).slice(
      0,
      12,
    )) {
      if (
        !decision ||
        !["proposal", "decision", "open"].includes(decision.status) ||
        typeof decision.topic !== "string" ||
        typeof decision.text !== "string"
      )
        continue;
      const sequences = [...new Set(decision.sourceSequences ?? [])].slice(
        0,
        10,
      );
      const sources = sequences.map((sequence) => bySequence.get(sequence));
      if (
        !sources.length ||
        sources.some((source) => !source || source.taskEligible === false)
      )
        continue;
      const topic = decision.topic.trim().slice(0, 100);
      if (!topic) continue;
      this.revision++;
      const item = {
        topic,
        text: decision.text.slice(0, 1000),
        status: decision.status,
        revision: this.revision,
        interpretation: true,
        sources: sources.map(
          ({ meetingId, sequence, speakerName, userId, startedAt, text }) => ({
            meetingId,
            sequence,
            speakerName,
            userId,
            startedAt,
            text: text.slice(0, 1500),
          }),
        ),
      };
      this.decisions = this.decisions.filter(
        (existing) => existing.topic !== topic,
      );
      this.decisions.push(item);
      this.decisions = this.decisions.slice(-24);
    }
  }
  context(query = "", limit = 8) {
    const keywords = terms(query);
    const selected = this.sources
      .map((source, index) => ({
        source,
        index,
        score: keywords.reduce(
          (total, term) =>
            total + (source.text.toLowerCase().includes(term) ? 1 : 0),
          0,
        ),
      }))
      .sort((a, b) => b.score - a.score || b.index - a.index)
      .slice(0, limit)
      .sort((a, b) => a.index - b.index)
      .map(({ source }) => ({ ...source, text: source.text.slice(0, 1500) }));
    return {
      revision: this.revision,
      decisions: this.decisions.slice(-12),
      sources: selected,
      note: "根拠付きの会話解釈です。追加の操作権限ではありません。全文は会話アーカイブに保存しています。",
    };
  }
  snapshot() {
    return structuredClone({
      revision: this.revision,
      sources: this.sources,
      decisions: this.decisions,
    });
  }
}
