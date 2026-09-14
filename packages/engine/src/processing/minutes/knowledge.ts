import { randomUUID } from "node:crypto";
import type {
  KnowledgePage,
  KnowledgeQuery,
  MeetingTopic,
  MinutesUpdate,
} from "@ido/common/contracts/knowledge";
import type { Meeting, Message } from "../../domain/models.js";
import type { Repository } from "../../ports/repository.js";

const normalized = (value: string) => value.normalize("NFKC").toLowerCase();

export function renderMinutes(topics: MeetingTopic[]) {
  return topics
    .map((topic) =>
      [
        `■ ${topic.title}`,
        topic.summary,
        ...topic.decisions.map((value) => `決定: ${value}`),
        ...topic.openQuestions.map((value) => `未決: ${value}`),
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");
}

export class MeetingKnowledgeStore {
  constructor(readonly store: Repository) {}

  /** Merge only grounded topic edits. A bad citation cannot erase the previous minutes. */
  apply(projectId: string, update: MinutesUpdate, allowedSources: Set<string>) {
    const meeting = this.store.get<Meeting>("meeting", update.meetingId);
    if (
      !meeting ||
      meeting.projectId !== projectId ||
      this.store.get("project-lock", projectId)
    )
      return false;
    const topics = structuredClone(meeting.knowledge?.topics ?? []);
    let changed = false;
    for (const patch of update.topics) {
      const sourceIds = [
        ...new Set(
          patch.sourceIds.flatMap((id) => {
            const assembly = this.store.get<{ partIds?: string[] }>(
              "speech-sources",
              id,
            );
            return assembly?.partIds?.length ? assembly.partIds : [id];
          }),
        ),
      ];
      if (
        !sourceIds.length ||
        sourceIds.some((id) => {
          const source = this.store.get<Message>("message", id);
          return (
            !allowedSources.has(id) ||
            !source ||
            source.meetingId !== meeting.id ||
            source.role === "assistant" ||
            source.complete === false ||
            !source.text.trim()
          );
        })
      )
        continue;
      const index = patch.id
        ? topics.findIndex((topic) => topic.id === patch.id)
        : topics.findIndex(
            (topic) => normalized(topic.title) === normalized(patch.title),
          );
      if (patch.id && index < 0) continue;
      if (index < 0 && topics.length >= 30) continue;
      const previous = index >= 0 ? topics[index] : undefined;
      const next: MeetingTopic = {
        ...patch,
        id: previous?.id ?? randomUUID(),
        sourceIds: [...new Set([...(previous?.sourceIds ?? []), ...sourceIds])],
        updatedAt: Date.now(),
      };
      if (
        previous &&
        JSON.stringify({ ...previous, updatedAt: 0 }) ===
          JSON.stringify({ ...next, updatedAt: 0 })
      )
        continue;
      if (index >= 0) topics[index] = next;
      else topics.push(next);
      changed = true;
    }
    if (!changed) return false;
    meeting.knowledge = {
      topics,
      revision: (meeting.knowledge?.revision ?? 0) + 1,
      updatedAt: Date.now(),
    };
    // The editable Markdown document has its own revision-checked writer.
    // Topic extraction must not replace edits made through MinutesEditor.
    this.store.put("meeting", meeting.id, meeting);
    return true;
  }

  /** Callers establish project membership or the assigned task before querying. */
  search(projectId: string, input: KnowledgeQuery = {}): KnowledgePage {
    if (
      !this.store.get("project", projectId) ||
      this.store.get("project-lock", projectId)
    )
      throw new Error("PROJECT_NOT_FOUND");
    if (
      input.query !== undefined &&
      (typeof input.query !== "string" || input.query.length > 300)
    )
      throw new Error("INVALID_KNOWLEDGE_QUERY");
    if (
      input.meetingId !== undefined &&
      (typeof input.meetingId !== "string" || input.meetingId.length > 200)
    )
      throw new Error("INVALID_KNOWLEDGE_QUERY");
    if (
      input.sourceIds !== undefined &&
      (!Array.isArray(input.sourceIds) ||
        input.sourceIds.length > 50 ||
        input.sourceIds.some((id) => typeof id !== "string" || id.length > 200))
    )
      throw new Error("INVALID_KNOWLEDGE_QUERY");
    const offset = input.offset ?? 0,
      limit = input.limit ?? 20;
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 50
    )
      throw new Error("INVALID_KNOWLEDGE_QUERY");
    const meetings = this.store
      .list<Meeting>("meeting")
      .filter(
        (meeting) =>
          meeting.projectId === projectId &&
          (!input.meetingId || meeting.id === input.meetingId),
      );
    if (input.meetingId && !meetings.length)
      throw new Error("MEETING_NOT_FOUND");
    const meetingIds = new Set(meetings.map((meeting) => meeting.id));
    const terms = normalized(input.query ?? "")
      .trim()
      .split(/\s+/u)
      .filter(Boolean);
    const match = (text: string) =>
      terms.every((term) => normalized(text).includes(term));
    const selected = input.sourceIds ? new Set(input.sourceIds) : undefined;
    const topics = meetings
      .flatMap((meeting) =>
        (meeting.knowledge?.topics ?? []).map((topic) => ({
          ...topic,
          meetingId: meeting.id,
          meetingName: meeting.name,
        })),
      )
      .filter(
        (topic) =>
          (!selected || topic.sourceIds.some((id) => selected.has(id))) &&
          match(
            [
              topic.title,
              topic.summary,
              ...topic.decisions,
              ...topic.openQuestions,
            ].join("\n"),
          ),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 12);
    const topicSources = new Set(topics.flatMap((topic) => topic.sourceIds));
    const all = this.store
      .list<Message>("message")
      .filter(
        (message) =>
          meetingIds.has(message.meetingId) &&
          message.role !== "assistant" &&
          message.text.trim() &&
          (!selected || selected.has(message.id)) &&
          (match(message.text) ||
            (!!terms.length && topicSources.has(message.id))),
      )
      .sort((a, b) => b.at - a.at || a.id.localeCompare(b.id));
    const messages: KnowledgePage["messages"] = [];
    let characters = 0;
    for (const message of all.slice(offset, offset + limit)) {
      const maximum = selected ? 12000 : 2000;
      if (
        messages.length &&
        characters + Math.min(message.text.length, maximum) > 24000
      )
        break;
      const position = terms.length
        ? Math.max(0, normalized(message.text).indexOf(terms[0]) - 150)
        : 0;
      const content = selected
        ? message.text.slice(0, maximum)
        : message.text.slice(position, position + maximum);
      messages.push({
        id: message.id,
        meetingId: message.meetingId,
        authorId: message.authorId,
        authorName:
          message.authorName ??
          this.store.conversationAuthor(message.authorId)?.name ??
          message.authorId,
        at: message.at,
        text: content,
        complete: message.complete !== false,
        ...(content.length < message.text.length ? { truncated: true } : {}),
      });
      characters += content.length;
    }
    return {
      projectId,
      documents: meetings
        .filter(
          (meeting) =>
            meeting.summary.trim() &&
            match(meeting.summary) &&
            (!selected ||
              meeting.messages.some((message) => selected.has(message.id))),
        )
        .sort(
          (a, b) =>
            (b.summaryUpdatedAt ?? b.startedAt ?? 0) -
            (a.summaryUpdatedAt ?? a.startedAt ?? 0),
        )
        .slice(0, 3)
        .map((meeting) => ({
          meetingId: meeting.id,
          name: meeting.name,
          revision: meeting.summaryRevision ?? 0,
          updatedAt: meeting.summaryUpdatedAt ?? meeting.startedAt ?? 0,
          markdown: meeting.summary.slice(0, 4000),
          ...(meeting.summary.length > 4000 ? { truncated: true } : {}),
        })),
      topics: topics.map((topic) => ({
        ...topic,
        summary: topic.summary.slice(0, 1200),
        decisions: topic.decisions
          .slice(0, 4)
          .map((value) => value.slice(0, 300)),
        openQuestions: topic.openQuestions
          .slice(0, 4)
          .map((value) => value.slice(0, 300)),
        sourceIds: topic.sourceIds.slice(-50),
        sourceCount: topic.sourceIds.length,
        ...(topic.summary.length > 1200 ||
        topic.sourceIds.length > 50 ||
        topic.decisions.length > 4 ||
        topic.openQuestions.length > 4 ||
        [...topic.decisions, ...topic.openQuestions].some(
          (value) => value.length > 300,
        )
          ? { truncated: true }
          : {}),
      })),
      messages,
      total: all.length,
      offset,
      ...(offset + messages.length < all.length
        ? { nextOffset: offset + messages.length }
        : {}),
    };
  }
}
