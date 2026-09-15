import { useState } from "react";
import { Alert, Button, Checkbox, Stack, Text, TextInput } from "@mantine/core";
import type { Action } from "@ido/common-ui";

type Failure = {
  projectId: string;
  taskId: string;
  threadId?: string;
  error: string;
};
export function ForumRecovery({ action }: { action: Action }) {
  const [rows, setRows] = useState<Failure[]>([]),
    [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<Failure>();
  const [thread, setThread] = useState(""),
    [recreate, setRecreate] = useState(false);
  const run = async (recover = false) => {
    setBusy(true);
    setMessage("");
    try {
      if (recover && selected)
        await action("plugins/forum", {
          action: "recover",
          ...selected,
          threadId: thread,
          recreate,
        });
      const result = (await action("plugins/forum", {
        action: "status",
      })) as unknown as { errors: Failure[] };
      setRows(result.errors);
      setSelected(undefined);
      setRecreate(false);
      if (!result.errors.length)
        setMessage("現在、記録されている同期エラーはありません。");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <details>
      <summary>issueフォーラムの同期・復旧</summary>
      <Stack mt="sm">
        <Text size="sm">
          送信結果が不明な場合は自動で重複投稿しません。Discordで既存スレッドを確認してから復旧してください。
        </Text>
        <Button loading={busy} onClick={() => void run()}>
          同期状態を確認
        </Button>
        {rows.map((row) => (
          <Button
            key={row.taskId}
            variant="light"
            onClick={() => {
              setSelected(row);
              setThread(row.threadId ?? "");
              setRecreate(false);
            }}
          >
            {row.taskId} · {row.error}
          </Button>
        ))}
        {selected && (
          <>
            <Text>{selected.taskId}</Text>
            <TextInput
              label="既存スレッドID（空欄なら検索）"
              value={thread}
              disabled={recreate}
              onChange={(e) => setThread(e.currentTarget.value)}
            />
            <Checkbox
              checked={recreate}
              onChange={(e) => setRecreate(e.currentTarget.checked)}
              label="新しいスレッドを作り直す（会話を再投稿。古いスレッドは残ります）"
            />
            <Button loading={busy} onClick={() => void run(true)}>
              選択したスレッドを復旧
            </Button>
          </>
        )}
        {message && <Alert>{message}</Alert>}
      </Stack>
    </details>
  );
}
