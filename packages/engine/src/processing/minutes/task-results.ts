import { createHash } from "node:crypto";
import { taskMarkdown } from "@ido/common/contracts/api";
import type { Task } from "@ido/common/contracts/protocol";
import type { MinutesTaskResult } from "@ido/common/contracts/work";

export interface ResultProgress {
  fingerprint: string;
  offset: number;
  complete: boolean;
}
export interface ResultPart {
  key: string;
  progress: ResultProgress;
  value: MinutesTaskResult;
}

const resultText = (value: {
  result?: string;
  progress?: string;
  state?: string;
}) =>
  [value.state !== "completed" ? value.progress : undefined, value.result]
    .filter(
      (text): text is string => typeof text === "string" && text.length > 0,
    )
    .join("\n") || "結果本文なし";

// Read every version and character incrementally, independent of speech output.
export function taskResultParts(
  tasks: Task[],
  processed: Record<string, ResultProgress> = {},
): ResultPart[] {
  const parts: ResultPart[] = [];
  for (const task of tasks) {
    const versions = [
      ...(task.history ?? [])
        .filter(
          (entry) =>
            entry.result !== undefined ||
            entry.progress !== undefined ||
            entry.state !== undefined,
        )
        .map((entry) => ({
          revision: entry.revision,
          runId: entry.runId ?? task.runId,
          text: resultText(entry),
          state: entry.state ?? "previous",
        })),
      ...(["completed", "failed", "cancelled", "interrupted"].includes(
        task.state,
      )
        ? [
            {
              revision: task.revision,
              runId: task.runId,
              text: resultText(task),
              state: task.state,
            },
          ]
        : []),
    ];
    for (const version of versions) {
      const key = JSON.stringify([task.id, version.runId, version.revision]);
      const fingerprint = createHash("sha256")
        .update(JSON.stringify([version.text, version.state, task.title]))
        .digest("hex");
      const previous = processed[key];
      if (previous?.fingerprint === fingerprint && previous.complete) continue;
      let offset = previous?.fingerprint === fingerprint ? previous.offset : 0;
      do {
        let end = Math.min(offset + 4000, version.text.length);
        if (
          /[\uD800-\uDBFF]/u.test(version.text[end - 1] ?? "") &&
          /[\uDC00-\uDFFF]/u.test(version.text[end] ?? "")
        )
          end--;
        parts.push({
          key,
          progress: {
            fingerprint,
            offset: end,
            complete: end === version.text.length,
          },
          value: {
            sourceIds: task.sourceIds?.slice(0, 20) ?? [],
            taskId: task.id,
            title: task.title ?? task.text.slice(0, 90),
            link: taskMarkdown(
              { projectId: task.projectId, taskId: task.id },
              task.title ?? task.text.slice(0, 90),
            ),
            runId: version.runId,
            revision: version.revision,
            state: version.state,
            offset,
            totalCharacters: version.text.length,
            text: version.text.slice(offset, end),
          },
        });
        offset = end;
        if (parts.length >= 4) return parts;
      } while (offset < version.text.length);
    }
  }
  return parts;
}
