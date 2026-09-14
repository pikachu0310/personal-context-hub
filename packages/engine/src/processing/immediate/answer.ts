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
  return models.answer(
    store.get<Meeting>("meeting", meetingId),
    store.list<Task>("task").filter((t) => t.meetingId === meetingId),
    question,
  );
}
