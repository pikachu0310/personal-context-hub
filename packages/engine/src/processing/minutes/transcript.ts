import type {
  MessageView,
  TranscriptPage,
  TranscriptQuery,
} from "@ido/common/contracts/api";
import type { Meeting, Message } from "../../domain/models.js";
import type { Repository } from "../../ports/repository.js";

export function messageView(message: Omit<Message, "meetingId">): MessageView {
  return {
    id: message.id,
    authorId: message.authorId,
    authorName: message.authorName,
    role: message.role,
    text: message.text,
    replyText: message.replyText,
    at: message.at,
    stage: message.stage,
    steps: message.steps,
  };
}

/** Membership is checked by the caller. Return original words in bounded pages. */
export function transcriptPage(
  store: Repository,
  projectId: string,
  input: TranscriptQuery = {},
): TranscriptPage {
  if (
    input.query !== undefined &&
    (typeof input.query !== "string" || input.query.length > 300)
  )
    throw new Error("INVALID_TRANSCRIPT_QUERY");
  for (const key of ["meetingId", "topicId"] as const)
    if (
      input[key] !== undefined &&
      (typeof input[key] !== "string" || input[key].length > 200)
    )
      throw new Error("INVALID_TRANSCRIPT_QUERY");
  if (
    input.before !== undefined &&
    (!input.before ||
      !Number.isFinite(input.before.at) ||
      typeof input.before.id !== "string" ||
      input.before.id.length > 200)
  )
    throw new Error("INVALID_TRANSCRIPT_QUERY");
  const meetings = store
    .list<Meeting>("meeting")
    .filter(
      (m) =>
        m.projectId === projectId &&
        (!input.meetingId || m.id === input.meetingId),
    );
  if (input.meetingId && !meetings.length) throw new Error("MEETING_NOT_FOUND");
  const names = new Map(meetings.map((m) => [m.id, m.name]));
  const topic = input.topicId
    ? meetings
        .flatMap((m) => m.knowledge?.topics ?? [])
        .find((t) => t.id === input.topicId)
    : undefined;
  if (input.topicId && !topic) throw new Error("TOPIC_NOT_FOUND");
  const selected = topic && new Set(topic.sourceIds);
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
  const terms = normalize(input.query ?? "")
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const all = store
    .list<Message>("message")
    .filter(
      (m) =>
        names.has(m.meetingId) &&
        m.role !== "assistant" &&
        m.text.trim() &&
        (!selected || selected.has(m.id)) &&
        terms.every((term) =>
          normalize(`${m.authorName ?? m.authorId} ${m.text}`).includes(term),
        ),
    )
    .sort((a, b) => b.at - a.at || b.id.localeCompare(a.id));
  const older = input.before
    ? all.filter(
        (m) =>
          m.at < input.before!.at ||
          (m.at === input.before!.at &&
            m.id.localeCompare(input.before!.id) < 0),
      )
    : all;
  const messages: TranscriptPage["messages"] = [];
  let characters = 0;
  for (const message of older) {
    if (
      messages.length >= 100 ||
      (messages.length && characters + message.text.length > 128000)
    )
      break;
    messages.push({
      ...messageView(message),
      meetingId: message.meetingId,
      meetingName: names.get(message.meetingId)!,
    });
    characters += message.text.length;
  }
  const last = messages.at(-1);
  return {
    messages,
    total: all.length,
    ...(last && messages.length < older.length
      ? { next: { at: last.at, id: last.id } }
      : {}),
  };
}
