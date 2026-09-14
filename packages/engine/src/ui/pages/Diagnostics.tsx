import { Text } from "@mantine/core";
import type { AdminState } from "@ido/common-ui";
import { diagnosticLines } from "./diagnostic-lines.js";

export function Diagnostics({
  state,
  page,
}: {
  state: AdminState;
  page: string;
}) {
  if (page !== "diagnostics" || state.user.role !== "admin") return null;
  const lines = diagnosticLines(state.diagnostics ?? []);
  return (
    <section aria-label="エラーログ">
      <Text size="sm" c="dimmed" mb="xs">
        最新100行を表示（新しい順） · {lines.length}行 · エラーIDで照合できます
      </Text>
      <pre className="admin-log" tabIndex={0} aria-label="エラーログ出力">
        {lines.length ? lines.join("\n") : "記録されたエラーはありません。"}
      </pre>
    </section>
  );
}
