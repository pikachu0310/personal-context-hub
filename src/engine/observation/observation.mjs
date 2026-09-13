import { requestedVoiceModel } from "../model-policy.mjs";
import {
  boundText,
  boundRecentText,
  MAX_RESPONSE_CHARACTERS,
} from "../shared.mjs";
import { VoiceServiceError } from "../errors.mjs";
const MAX_MEETING_MINUTES_CHARACTERS = 10_000;
const MAX_MEETING_TRANSCRIPT_CHARACTERS = 16_000;
export function speakerLabel(statement) {
  return boundText(
    String(statement.speakerName ?? statement.userId ?? "不明な話者")
      .replace(/[\r\n]+/g, " ")
      .trim(),
    80,
    "…",
  );
}

export function formatMeetingObservationTranscript(statements) {
  const ordered = [...statements].sort(
    (left, right) =>
      (left.startedAt ?? 0) - (right.startedAt ?? 0) ||
      (left.sequence ?? 0) - (right.sequence ?? 0),
  );
  const transcript = ordered
    .map((statement) => `[${speakerLabel(statement)}] ${statement.text}`)
    .join("\n");
  return boundRecentText(transcript, MAX_MEETING_TRANSCRIPT_CHARACTERS);
}

export function parseMeetingObservation(value, fallbackMinutes = "") {
  const text = String(value ?? "").trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate =
    fenced ?? text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch (error) {
    throw new VoiceServiceError(
      "MEETING_OBSERVATION_INVALID",
      "Meeting observation did not return valid JSON.",
      "会議の観測結果を整理できませんでした。次回の観測で再試行します。",
      { cause: error },
    );
  }
  const minutes =
    boundText(parsed?.minutes, MAX_MEETING_MINUTES_CHARACTERS) ||
    boundText(fallbackMinutes, MAX_MEETING_MINUTES_CHARACTERS) ||
    "まだ議事録に残す要点はありません。";
  const reply = boundText(parsed?.reply, MAX_RESPONSE_CHARACTERS);
  const tasks = Array.isArray(parsed?.tasks)
    ? parsed.tasks.slice(0, 3).map((task) => ({
        title: boundText(task?.title, 120, "…") || "Codexタスク",
        kind: task?.kind ?? "implementation",
        complexity: task?.complexity ?? "routine",
        acceptanceCriteria: Array.isArray(task?.acceptanceCriteria)
          ? task.acceptanceCriteria
              .slice(0, 5)
              .map((text) => boundText(text, 500))
              .filter(Boolean)
          : [],
        sourceSequences: Array.isArray(task?.sourceSequences)
          ? [
              ...new Set(
                task.sourceSequences.filter(
                  (sequence) => Number.isInteger(sequence) && sequence > 0,
                ),
              ),
            ].slice(0, 20)
          : [],
      }))
    : [];
  const taskControls = Array.isArray(parsed?.taskControls)
    ? parsed.taskControls.slice(0, 3).map((control) => ({
        taskId: typeof control.taskId === "string" ? control.taskId : undefined,
        type:
          control?.type === "stop" || control?.type === "instruction"
            ? control.type
            : undefined,
        sourceSequences: Array.isArray(control?.sourceSequences)
          ? [
              ...new Set(
                control.sourceSequences.filter(
                  (sequence) => Number.isInteger(sequence) && sequence > 0,
                ),
              ),
            ].slice(0, 20)
          : [],
      }))
    : [];
  return {
    minutes,
    shouldReply: parsed?.shouldReply === true && Boolean(reply),
    reply,
    tasks,
    taskControls,
    decisions: Array.isArray(parsed?.decisions)
      ? parsed.decisions.slice(0, 12)
      : [],
  };
}

export function authorizeMeetingTaskControls(
  controls,
  statements,
  ownerUserId,
) {
  if (!ownerUserId || !Array.isArray(controls) || !Array.isArray(statements))
    return [];
  const bySequence = new Map(
    statements.map((statement) => [statement.sequence, statement]),
  );
  return controls.flatMap((control) => {
    const sources = control.sourceSequences
      .map((sequence) => bySequence.get(sequence))
      .filter(Boolean);
    if (
      !control.type ||
      !sources.length ||
      sources.length !== control.sourceSequences.length ||
      sources.some(
        (statement) =>
          statement.userId !== ownerUserId || statement.taskEligible === false,
      )
    )
      return [];
    const instruction = sources
      .map((statement) => statement.text)
      .join("\n")
      .trim();
    return instruction
      ? [
          {
            type: control.type,
            instruction,
            sourceSequences: [...control.sourceSequences],
            ...(control.taskId ? { taskId: control.taskId } : {}),
          },
        ]
      : [];
  });
}

export function authorizeMeetingTasks(tasks, statements, ownerUserId) {
  if (!ownerUserId || !Array.isArray(tasks) || !Array.isArray(statements))
    return [];
  const bySequence = new Map(
    statements.map((statement) => [statement.sequence, statement]),
  );
  const context = formatMeetingObservationTranscript(statements);
  const authorizedSources = new Set();
  return tasks.flatMap((task) => {
    const sources = task.sourceSequences
      .map((sequence) => bySequence.get(sequence))
      .filter(Boolean);
    if (
      !sources.length ||
      sources.length !== task.sourceSequences.length ||
      sources.some(
        (statement) =>
          statement.userId !== ownerUserId || statement.taskEligible === false,
      )
    ) {
      return [];
    }
    const sourceKey = [...task.sourceSequences].sort((a, b) => a - b).join(",");
    if (authorizedSources.has(sourceKey)) return [];
    authorizedSources.add(sourceKey);
    const request = sources
      .map((statement) => statement.text)
      .join("\n")
      .trim();
    if (!request) return [];
    return [
      {
        title: task.title,
        kind: task.kind,
        complexity: task.complexity,
        request,
        context,
        sourceSequences: [...task.sourceSequences],
        modelSelection: requestedVoiceModel(request),
        acceptanceCriteria: task.acceptanceCriteria,
        sourceStatements: sources.map((statement) => ({
          meetingId: statement.meetingId,
          sequence: statement.sequence,
          userId: statement.sourceUserId ?? statement.userId,
          speakerName: statement.speakerName,
          startedAt: statement.startedAt,
          text: statement.text,
        })),
      },
    ];
  });
}
