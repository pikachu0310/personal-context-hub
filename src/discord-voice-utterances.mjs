const MAX_ASSEMBLED_TEXT = 16_000;

export class SpeechTurnAssembler {
  constructor(records = []) {
    this.turns = new Map(
      records.map((record) => [record.id, structuredClone(record)]),
    );
  }

  register(id, index, metadata) {
    if (!Number.isInteger(index) || index < 0)
      throw new TypeError("segment index must be nonnegative");
    let turn = this.turns.get(id);
    if (!turn) {
      turn = { id, ...metadata, parts: {}, expectedParts: undefined };
      this.turns.set(id, turn);
    }
    turn.parts[index] ??= { status: "pending" };
    return turn;
  }

  settle(id, index, statement) {
    const turn = this.turns.get(id);
    if (!turn || turn.parts[index]?.status === "settled") return;
    turn.parts[index] = { status: "settled", statement };
    if (!statement) turn.incomplete = true;
  }

  finish(id, count, incomplete = false) {
    const turn = this.turns.get(id);
    if (!turn) return;
    turn.expectedParts = count;
    turn.incomplete ||= incomplete;
  }

  snapshot() {
    return structuredClone([...this.turns.values()]);
  }

  interrupt() {
    for (const turn of this.turns.values()) {
      if (
        turn.expectedParts !== undefined &&
        Array.from(
          { length: turn.expectedParts },
          (_, index) => turn.parts[index],
        ).every((part) => part?.status === "settled")
      )
        continue;
      turn.incomplete = true;
      turn.expectedParts =
        Math.max(0, ...Object.keys(turn.parts).map(Number)) + 1;
      for (let index = 0; index < turn.expectedParts; index++)
        if (turn.parts[index]?.status !== "settled")
          turn.parts[index] = { status: "settled" };
    }
  }

  drain() {
    const completed = [];
    for (const turn of this.turns.values()) {
      if (turn.expectedParts === undefined) continue;
      const parts = Array.from(
        { length: turn.expectedParts },
        (_, index) => turn.parts[index],
      );
      if (parts.some((part) => part?.status !== "settled")) continue;
      this.turns.delete(turn.id);
      const statements = parts.flatMap((part) =>
        part.statement ? [part.statement] : [],
      );
      const text = statements.map((statement) => statement.text).join("\n");
      if (!text) continue;
      const incomplete = turn.incomplete || text.length > MAX_ASSEMBLED_TEXT;
      completed.push({
        id: turn.id,
        meetingId: turn.meetingId,
        sequence: turn.sequence,
        userId: turn.userId,
        speakerName: turn.speakerName,
        startedAt: turn.startedAt,
        text:
          (text.length > MAX_ASSEMBLED_TEXT
            ? "【長い発話の末尾のみ。全文は会話ログを参照。作業の実行指示として使用しない】\n"
            : incomplete
              ? "【発話の一部のみ認識。作業の実行指示として使用しない】\n"
              : "") + text.slice(-MAX_ASSEMBLED_TEXT),
        observed: false,
        archived: statements.every((statement) => statement.archived),
        taskEligible: !incomplete,
        archiveParts: statements.filter((statement) => !statement.archived),
      });
    }
    return completed;
  }
}
