import { MinutesInspector } from "./MinutesInspector.js";
import { Button, Text } from "@mantine/core";
import { useCallback, useRef, useState, type ComponentProps } from "react";
import type {
  MeetingView,
  TranscriptPage,
  TranscriptQuery,
} from "@ido/common/contracts/api";
import { MinutesEditor } from "./MinutesEditor.js";
import { visibleMinutes } from "./minutes-list.js";

type Props = Omit<ComponentProps<typeof MinutesEditor>, "meeting"> & {
  meetings: MeetingView[];
  loadTranscript?: (query: TranscriptQuery) => Promise<TranscriptPage>;
};

export function MinutesList({
  meetings,
  dirtyChanged,
  loadTranscript,
  ...editor
}: Props) {
  const [selectedId, select] = useState<string>();
  const [pane, setPane] = useState("document");
  const [dirty, setDirty] = useState(false);
  const lastSelected = useRef<MeetingView>(undefined);
  const list = visibleMinutes(meetings);
  const current = meetings.find((meeting) => meeting.id === selectedId);
  // Keep an in-progress edit mounted even if a refresh removes/empties its record.
  if (current) lastSelected.current = current;
  const selected =
    current ?? (selectedId && dirty ? lastSelected.current : undefined);
  const loadSelectedTranscript = useCallback(
    (query: TranscriptQuery) =>
      loadTranscript!({ ...query, meetingId: selected?.id }),
    [loadTranscript, selected?.id],
  );
  const changed = useCallback(
    (id: string, value: boolean) => {
      setDirty(value);
      dirtyChanged(id, value);
    },
    [dirtyChanged],
  );
  if (selected && (selected.summary.trim() || dirty))
    return (
      <section
        className="minutes-detail"
        aria-label="議事録の詳細"
        data-pane={pane}
      >
        <div className="minutes-detail-toolbar">
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
          <div
            className="minutes-pane-switch"
            role="group"
            aria-label="議事録の表示切り替え"
          >
            <Button
              size="compact-xs"
              variant={pane === "document" ? "light" : "subtle"}
              aria-pressed={pane === "document"}
              onClick={() => setPane("document")}
            >
              本文
            </Button>
            <Button
              size="compact-xs"
              variant={pane === "context" ? "light" : "subtle"}
              aria-pressed={pane === "context"}
              onClick={() => setPane("context")}
            >
              詳細・発言
            </Button>
          </div>
        </div>
        <div className="minutes-reading-layout">
          <div className="minutes-reader" tabIndex={0} aria-label="議事録本文">
            <MinutesEditor
              meeting={selected}
              dirtyChanged={changed}
              {...editor}
            />
          </div>
          <MinutesInspector
            key={selected.id}
            meetings={[selected]}
            loadTranscript={loadTranscript ? loadSelectedTranscript : undefined}
          />
        </div>
      </section>
    );
  return (
    <section className="minutes-list-section" aria-label="議事録一覧">
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
              onClick={() => {
                select(meeting.id);
                setPane("document");
              }}
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
