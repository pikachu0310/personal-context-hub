import { Badge, Stack, Text } from "@mantine/core";
import type { TaskPriority as Priority } from "@ido/common/contracts/work";

export function TaskPriority({ priority }: { priority?: Priority }) {
  if (!priority)
    return (
      <Text size="xs" c="dimmed">
        未評価（既存の受付順・優先度）
      </Text>
    );
  const labels = {
    resolved: "解決済み",
    unspecified: "具体化待ち",
    below_threshold: "実行閾値未満",
    deferred: "保留",
  };
  return (
    <Stack gap={4}>
      <Badge variant="light" color={priority.eligible ? "blue" : "gray"}>
        優先度 {priority.score} / 100
        {!priority.eligible
          ? ` · ${labels[priority.reason as keyof typeof labels] ?? "待機"}`
          : ""}
      </Badge>
      <Text size="xs">{priority.evaluation.reason}</Text>
      <Text size="xs" c="dimmed">
        即時性 {priority.evaluation.immediacy} · 確実性{" "}
        {priority.evaluation.certainty} · 重要性{" "}
        {priority.evaluation.importance} · 具体性{" "}
        {priority.evaluation.specificity}（各0〜4）
      </Text>
    </Stack>
  );
}
