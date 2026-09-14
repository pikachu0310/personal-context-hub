import { MeetingNotes } from "@ido/common-ui";
import { Button, Text } from "@mantine/core";
import { useCallback, useRef, useState, type ComponentProps } from "react";
import type { MeetingView } from "@ido/common/contracts/api";
import { MinutesEditor } from "./MinutesEditor.js";
import { visibleMinutes } from "./minutes-list.js";

type Props = Omit<ComponentProps<typeof MinutesEditor>, "meeting"> & {
  meetings: MeetingView[];
};

export function MinutesList({ meetings, dirtyChanged, ...editor }: Props) {
  const [selectedId, select] = useState<string>();
  const [dirty, setDirty] = useState(false);
  const lastSelected = useRef<MeetingView>(undefined);
  const list = visibleMinutes(meetings);
  const current = meetings.find((meeting) => meeting.id === selectedId);
  // Keep an in-progress edit mounted even if a refresh removes/empties its record.
  if (current) lastSelected.current = current;
  const selected =
    current ?? (selectedId && dirty ? lastSelected.current : undefined);
  const changed = useCallback(
    (id: string, value: boolean) => {
      setDirty(value);
      dirtyChanged(id, value);
    },
    [dirtyChanged],
  );
  if (selected && (selected.summary.trim() || dirty))
    return (
      <section className="minutes-detail" aria-label="議事録の詳細">
        <Button
          variant="subtle"
          size="xs"
          autoFocus
          onClick={() => {
            if (dirty && !window.confirm("未保存の変更を破棄しますか？"))
              return;
            select(undefined);
          }}
        >
          ← 議事録一覧に戻る
        </Button>
        <MinutesEditor meeting={selected} dirtyChanged={changed} {...editor} />
        <details>
          <summary>この議事録の議題・元の発言を確認</summary>
          <MeetingNotes key={selected.id} meetings={[selected]} />
        </details>
      </section>
    );
  return (
    <section aria-label="議事録一覧">
      <Text size="xs" c="dimmed" mb={6}>
        {list.length}件 · 新しい順
      </Text>
      {!list.length && (
        <Text c="dimmed">本文のある議事録はまだありません。</Text>
      )}
      <ul className="minutes-list">
        {list.map((meeting) => (
          <li key={meeting.id}>
            <button
              type="button"
              className="minutes-list-row"
              onClick={() => select(meeting.id)}
            >
              <time className="minutes-list-date">
                {meeting.startedAt !== undefined
                  ? new Date(meeting.startedAt).toLocaleString("ja-JP", {
                      year: "numeric",
                      month: "2-digit",
                      day: "2-digit",
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : "日時未設定"}
              </time>
              <span className="minutes-list-title">{meeting.name}</span>
              <span className="minutes-list-status">
                {meeting.summaryState === "updating"
                  ? "自動更新中"
                  : meeting.summaryState === "failed"
                    ? "自動更新に失敗"
                    : meeting.closedAt
                      ? "終了"
                      : "進行中"}
              </span>
              <span aria-hidden="true">›</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
