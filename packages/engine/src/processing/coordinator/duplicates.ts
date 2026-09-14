import type { Task } from "@ido/common/contracts/protocol";

const key = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
function grams(text: string) {
  return new Set(
    Array.from({ length: Math.max(0, text.length - 2) }, (_, index) =>
      text.slice(index, index + 3),
    ),
  );
}
export function sameOutcome(left: string, right: string) {
  const a = key(left),
    b = key(right);
  if (!a || !b) return false;
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 8) return false;
  const x = grams(a),
    y = grams(b);
  const overlap = [...x].filter((gram) => y.has(gram)).length;
  return overlap / new Set([...x, ...y]).size >= 0.66;
}
export function duplicateWork(
  tasks: Task[],
  title: string,
  sourceIds: string[],
  automatic: boolean,
  now = Date.now(),
) {
  return tasks.findLast((task) => {
    const active = ["queued", "assigned", "running", "interrupted"].includes(
      task.state,
    );
    if (!active && (!automatic || now - task.updatedAt > 5 * 60_000))
      return false;
    return (
      sourceIds.some((id) => task.sourceIds?.includes(id)) ||
      sameOutcome(task.title ?? task.text, title)
    );
  });
}
