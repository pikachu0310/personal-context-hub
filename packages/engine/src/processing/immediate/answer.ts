import type { Task } from "@ido/common/contracts/protocol";
import type { Meeting } from "../../domain/models.js";
import type { Models } from "../../ports/models.js";
import type { Repository } from "../../ports/repository.js";
export function answer(
  store: Repository,
  models: Models,
  meetingId: string,
  question: string,
) {
  const meeting = store.get<Meeting>("meeting", meetingId);
  const reset = store.get("project-context", meeting?.projectId ?? "");
  return models.answer(
    meeting && reset
      ? {
          ...meeting,
          summary: "",
          messages: meeting.messages
            .filter((m) => (m as { role?: string }).role !== "assistant")
            .map(({ id, authorId, text, at, stage }) => ({
              id,
              authorId,
              text,
              at,
              stage,
            })),
        }
      : meeting,
    store.list<Task>("task").filter((t) => t.meetingId === meetingId),
    question,
  );
}
