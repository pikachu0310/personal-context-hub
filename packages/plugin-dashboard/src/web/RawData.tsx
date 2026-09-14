import {
  Alert,
  Button,
  Group,
  Loader,
  Pagination,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import { useEffect, useState } from "react";
import type { DashboardRawPage } from "@ido/common/contracts/api";
import { dateTime } from "./model.js";
const localDate = (at: number) => {
  const d = new Date(at);
  return new Date(at - d.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
};
export function RawData({
  projectId,
  targetId,
  eventTarget,
}: {
  projectId: string;
  targetId: string;
  eventTarget: boolean;
}) {
  const [kind, setKind] = useState(eventTarget ? "events" : "messages"),
    [target, setTarget] = useState(targetId);
  const [from, setFrom] = useState(
      localDate(Date.now() - (targetId ? 86400000 : 3600000)),
    ),
    [to, setTo] = useState(localDate(Date.now() + 60000));
  const [filter, setFilter] = useState({
      kind: eventTarget ? "events" : "messages",
      target: targetId,
      from,
      to,
    }),
    [page, setPage] = useState(1);
  const [result, setResult] = useState<DashboardRawPage>(),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setResult(undefined);
    setError("");
    const query = new URLSearchParams({
      ...filter,
      from: String(new Date(filter.from).getTime()),
      to: String(new Date(filter.to).getTime()),
      offset: String((page - 1) * 50),
      projectId,
    });
    const timeout = setTimeout(() => controller.abort(), 8000);
    void fetch(`/api/admin/dashboard/raw?${query}`, {
      signal: controller.signal,
      cache: "no-store",
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error);
        if (active) setResult(body);
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        clearTimeout(timeout);
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
      clearTimeout(timeout);
    };
  }, [filter, page, projectId]);
  return (
    <Stack>
      <Text size="sm" c="dimmed">
        閲覧専用。会話・議事録・管理操作の記録を表示します。本文は最大16,000文字、1ページ50件です。
      </Text>
      <Paper withBorder p="md">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            setFilter({ kind, target, from, to });
          }}
        >
          <Group align="flex-end">
            <Select
              label="データ種別"
              value={kind}
              onChange={(v) => setKind(v || "messages")}
              data={[
                { value: "messages", label: "会話" },
                { value: "minutes", label: "議事録" },
                { value: "events", label: "操作イベント" },
              ]}
              allowDeselect={false}
            />
            <TextInput
              label="対象ID"
              placeholder="会話・タスク・接続・記録ID"
              value={target}
              onChange={(e) => setTarget(e.currentTarget.value)}
            />
            <TextInput
              label="開始日時"
              type="datetime-local"
              required
              value={from}
              onChange={(e) => setFrom(e.currentTarget.value)}
            />
            <TextInput
              label="終了日時"
              type="datetime-local"
              required
              value={to}
              onChange={(e) => setTo(e.currentTarget.value)}
            />
            <Button type="submit">絞り込む</Button>
          </Group>
        </form>
      </Paper>
      {loading && <Loader size="sm" aria-label="読み込み中" />}
      {error && <Alert color="red">{error}</Alert>}
      {result && (
        <>
          <Group justify="space-between">
            <Text size="sm">{result.total}件</Text>
            <Pagination
              total={Math.max(1, Math.ceil(result.total / result.limit))}
              value={page}
              onChange={setPage}
              size="sm"
            />
          </Group>
          <Paper withBorder className="raw-log">
            {result.items.length ? (
              result.items.map((item) => (
                <section key={item.id}>
                  <Text size="xs" c="dimmed">
                    {dateTime(item.at)} · {item.targetId} · {item.id}
                  </Text>
                  <pre>{item.text || "本文なし"}</pre>
                </section>
              ))
            ) : (
              <Text className="empty">この条件に一致する記録はありません</Text>
            )}
          </Paper>
        </>
      )}
    </Stack>
  );
}
