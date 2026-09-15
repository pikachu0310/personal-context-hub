import { Button, Group, Tabs, Text, TextInput } from "@mantine/core";
import { useRef, useState } from "react";
import type { MeetingView } from "@ido/common/contracts/api";
import type {
  TranscriptPage,
  TranscriptQuery,
} from "@ido/common/contracts/api";
import { useTranscriptPage } from "./useTranscriptPage.js";
import { useFollowingLog } from "./useFollowingLog.js";

/** A bounded reader: selecting a topic never moves the adjacent minutes document. */
export function MinutesInspector({
  meetings,
  loadTranscript,
  initialTab = "topics",
}: {
  meetings: MeetingView[];
  loadTranscript?: (query: TranscriptQuery) => Promise<TranscriptPage>;
  initialTab?: "topics" | "transcript";
}) {
  const [tab, setTab] = useState<string | null>(initialTab);
  const [query, setQuery] = useState("");
  const [selected, select] = useState("");
  const [sources, setSources] = useState<{
    meetingId: string;
    topicId: string;
    ids: string[];
  }>();
  const [limit, setLimit] = useState(100);
  const topicBody = useRef<HTMLDivElement>(null);
  const terms = query
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const matches = (value: string) =>
    terms.every((term) => value.normalize("NFKC").toLowerCase().includes(term));
  const ordered = meetings.toSorted(
    (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0),
  );
  const topics = ordered
    .flatMap((meeting) =>
      (meeting.knowledge?.topics ?? []).map((topic) => ({
        ...topic,
        meeting,
        key: `${meeting.id}:${topic.id}`,
      })),
    )
    .filter((topic) =>
      matches(
        [
          topic.title,
          topic.summary,
          ...topic.decisions,
          ...topic.openQuestions,
        ].join("\n"),
      ),
    );
  const topic = topics.find((item) => item.key === selected) ?? topics[0];
  const remote = useTranscriptPage(
    loadTranscript,
    {
      query,
      ...(meetings.length === 1 ? { meetingId: meetings[0].id } : {}),
      ...(sources
        ? { meetingId: sources.meetingId, topicId: sources.topicId }
        : {}),
    },
    meetings
      .map(
        (m) =>
          `${m.id}:${m.lastMessageAt ?? m.messages.at(-1)?.at}:${m.knowledge?.revision}`,
      )
      .join("|"),
    tab === "transcript",
  );
  const messages = loadTranscript
    ? (remote.page?.messages ?? [])
        .map((message) => ({
          ...message,
          meeting: { id: message.meetingId, name: message.meetingName },
        }))
        .sort((a, b) => a.at - b.at)
    : ordered
        .flatMap((meeting) =>
          meeting.messages.map((message) => ({ ...message, meeting })),
        )
        .filter(
          (message) =>
            message.text.trim() &&
            (!sources ||
              (message.meeting.id === sources.meetingId &&
                sources.ids.includes(message.id))) &&
            matches(
              `${message.authorName ?? message.authorId} ${message.text} ${message.replyText ?? ""}`,
            ),
        )
        .sort((a, b) => a.at - b.at);
  const visibleMessages = loadTranscript ? messages : messages.slice(-limit);
  const log = useFollowingLog(
    `${meetings
      .map((meeting) => meeting.id)
      .sort()
      .join(":")}:${query}:${sources?.topicId ?? ""}`,
    visibleMessages,
    tab === "transcript",
    !query.trim() && !sources,
  );
  return (
    <section className="minutes-inspector" aria-label="議事録の関連情報">
      <h3 className="minutes-inspector-title">詳細を確認</h3>
      <Tabs value={tab} onChange={setTab} className="minutes-inspector-tabs">
        <Tabs.List grow>
          <Tabs.Tab value="topics">議題</Tabs.Tab>
          <Tabs.Tab value="transcript">発言ログ</Tabs.Tab>
        </Tabs.List>
        <TextInput
          className="minutes-inspector-search"
          size="xs"
          aria-label="議題・発言を検索"
          placeholder="議題・発言を検索"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setLimit(100);
          }}
        />
        <Tabs.Panel value="topics" className="minutes-inspector-panel">
          <div className="minutes-inspector-caption">
            {topics.length}件の議題 · 選択して詳細を確認
          </div>
          <nav className="minutes-topic-index" aria-label="議題一覧">
            {topics.map((item) => (
              <button
                type="button"
                key={item.key}
                aria-pressed={item.key === topic?.key}
                onClick={() => {
                  select(item.key);
                  topicBody.current?.scrollTo(0, 0);
                }}
              >
                <strong>{item.title}</strong>
                <span>{item.summary}</span>
              </button>
            ))}
          </nav>
          <div
            className="minutes-topic-content"
            ref={topicBody}
            tabIndex={0}
            aria-label="選択した議題の詳細"
          >
            {!topic ? (
              <Text size="sm" c="dimmed">
                {query
                  ? "一致する議題はありません。"
                  : "議題はまだありません。発言ログを確認できます。"}
              </Text>
            ) : (
              <>
                <h4>{topic.title}</h4>
                <Text size="xs" c="dimmed">
                  {meetings.length > 1 && `${topic.meeting.name} · `}
                  {new Date(topic.updatedAt).toLocaleString("ja-JP")}
                </Text>
                <h5>要点</h5>
                <p>{topic.summary}</p>
                <h5>決まったこと</h5>
                {topic.decisions.length ? (
                  <ul>
                    {topic.decisions.map((value, index) => (
                      <li key={index}>{value}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="minutes-muted">記録なし</p>
                )}
                <h5>未決事項</h5>
                {topic.openQuestions.length ? (
                  <ul>
                    {topic.openQuestions.map((value, index) => (
                      <li key={index}>{value}</li>
                    ))}
                  </ul>
                ) : (
                  <p className="minutes-muted">記録なし</p>
                )}
                <Button
                  variant="light"
                  size="xs"
                  fullWidth
                  disabled={!topic.sourceIds.length}
                  onClick={() => {
                    select(topic.key);
                    setSources({
                      meetingId: topic.meeting.id,
                      topicId: topic.id,
                      ids: topic.sourceIds,
                    });
                    setQuery("");
                    setLimit(Math.max(100, topic.sourceIds.length));
                    setTab("transcript");
                  }}
                >
                  元の発言を見る（{topic.sourceIds.length}件）
                </Button>
              </>
            )}
          </div>
        </Tabs.Panel>
        <Tabs.Panel value="transcript" className="minutes-inspector-panel">
          <div className="minutes-log-controls">
            {sources && (
              <>
                <Text size="xs" c="dimmed">
                  選択した議題の根拠となる発言
                </Text>
                <Group gap={4}>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => {
                      setQuery("");
                      setTab("topics");
                    }}
                  >
                    ← 議題に戻る
                  </Button>
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    onClick={() => {
                      setSources(undefined);
                      setQuery("");
                      setLimit(100);
                    }}
                  >
                    すべての発言
                  </Button>
                </Group>
              </>
            )}
            <Group justify="space-between" gap={4} wrap="wrap">
              <Text size="xs" c="dimmed">
                {remote.page?.total ?? messages.length}件の発言
                {loadTranscript
                  ? ` · ${messages.length}件を表示`
                  : messages.length > limit && ` · 直近${limit}件を表示`}
              </Text>
              <Button
                size="compact-xs"
                variant={log.unread ? "light" : "subtle"}
                onClick={log.latest}
                disabled={!visibleMessages.length || log.following}
              >
                {log.unread ? `新着${log.unread}件 · 最新へ ↓` : "最新へ ↓"}
              </Button>
            </Group>
            <Text size="xs" c="dimmed" role="status" aria-live="polite">
              {log.following
                ? "新着に追従中"
                : log.unread
                  ? `新しい発言が${log.unread}件あります`
                  : "閲覧位置を保持しています"}
            </Text>
          </div>
          <div
            className="minutes-log-content"
            ref={log.viewport}
            onScroll={log.onScroll}
            tabIndex={0}
            aria-label="発言の内容"
          >
            {(loadTranscript ? remote.page?.next : messages.length > limit) && (
              <Button
                size="xs"
                variant="subtle"
                loading={remote.loading}
                onClick={() =>
                  loadTranscript ? void remote.more() : setLimit(limit + 100)
                }
              >
                以前の発言をさらに表示
              </Button>
            )}
            {loadTranscript && remote.error && (
              <div role="alert">
                <Text size="sm" c="red">
                  {remote.error}
                </Text>
                <Button variant="subtle" size="xs" onClick={remote.retry}>
                  再読み込み
                </Button>
              </div>
            )}
            {loadTranscript && remote.loading && !messages.length && (
              <Text size="sm" role="status">
                発言を読み込んでいます…
              </Text>
            )}
            {!messages.length && !remote.loading && !remote.error && (
              <Text size="sm" c="dimmed">
                {query
                  ? "一致する発言はありません。"
                  : "表示できる発言はありません。"}
              </Text>
            )}
            {visibleMessages.map((message) => (
              <article
                className="minutes-statement"
                key={`${message.meeting.id}:${message.id}`}
                id={`statement-${message.id}`}
                data-log-id={message.id}
              >
                <header>
                  <strong>{message.authorName ?? message.authorId}</strong>
                  <time>{new Date(message.at).toLocaleString("ja-JP")}</time>
                </header>
                <p>{message.text}</p>
                {message.replyText && (
                  <p className="minutes-statement-reply">
                    IDO: {message.replyText}
                  </p>
                )}
                {meetings.length > 1 && (
                  <Text size="xs" c="dimmed">
                    {message.meeting.name}
                  </Text>
                )}
              </article>
            ))}
          </div>
        </Tabs.Panel>
      </Tabs>
    </section>
  );
}
