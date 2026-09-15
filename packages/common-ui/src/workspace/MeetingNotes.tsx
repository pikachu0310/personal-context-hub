import {
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Tabs,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type {
  MeetingView,
  TranscriptPage,
  TranscriptQuery,
} from "@ido/common/contracts/api";

export function MeetingNotes({
  meetings,
  document,
  loadTranscript,
}: {
  meetings: MeetingView[];
  document?: ReactNode;
  loadTranscript?: (query: TranscriptQuery) => Promise<TranscriptPage>;
}) {
  const [tab, setTab] = useState<string | null>(() =>
    document &&
    !meetings.some((meeting) => meeting.knowledge?.topics.length) &&
    meetings.some((meeting) => meeting.summary.trim())
      ? "document"
      : "minutes",
  );
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<string[]>([]);
  const [sourceTopic, setSourceTopic] = useState<{
    meetingId: string;
    topicId: string;
  }>();
  const [limit, setLimit] = useState(100);
  const [page, setPage] = useState<TranscriptPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const requestVersion = useRef(0);
  const pageKey = useRef("");
  const revision = meetings
    .map(
      (m) =>
        `${m.id}:${m.messageCount ?? m.messages.length}:${m.lastMessageAt ?? m.messages.at(-1)?.at}:${m.knowledge?.revision}`,
    )
    .join("|");
  useEffect(() => {
    if (!loadTranscript || tab !== "transcript") return;
    const version = ++requestVersion.current;
    const key = JSON.stringify([query, sourceTopic]);
    const changed = pageKey.current !== key;
    pageKey.current = key;
    if (changed) setPage(undefined);
    setLoading(true);
    setError("");
    const timer = setTimeout(
      () => {
        void loadTranscript({ query, ...sourceTopic })
          .then((result) => {
            if (requestVersion.current !== version) return;
            setPage((previous) => {
              if (
                !changed &&
                previous &&
                previous.messages.length > 100 &&
                result.total >= previous.messages.length
              ) {
                const retained = new Map(
                  previous.messages.map((m) => [m.id, m]),
                );
                for (const message of result.messages)
                  retained.set(message.id, message);
                return {
                  ...result,
                  messages: [...retained.values()],
                  next: previous.next,
                };
              }
              return result;
            });
          })
          .catch((e) => {
            if (requestVersion.current === version)
              setError((e as Error).message);
          })
          .finally(() => {
            if (requestVersion.current === version) setLoading(false);
          });
      },
      query ? 150 : 0,
    );
    return () => {
      clearTimeout(timer);
      requestVersion.current++;
    };
  }, [loadTranscript, tab, query, sourceTopic, revision, retry]);
  const more = async () => {
    if (!loadTranscript || !page?.next || loading) return;
    const version = requestVersion.current;
    setLoading(true);
    setError("");
    try {
      const result = await loadTranscript({
        query,
        ...sourceTopic,
        before: page.next,
      });
      if (requestVersion.current === version)
        setPage((previous) => ({
          ...result,
          messages: [
            ...new Map(
              [...(previous?.messages ?? []), ...result.messages].map((m) => [
                m.id,
                m,
              ]),
            ).values(),
          ],
        }));
    } catch (e) {
      if (requestVersion.current === version) setError((e as Error).message);
    } finally {
      if (requestVersion.current === version) setLoading(false);
    }
  };
  const terms = query
    .normalize("NFKC")
    .toLowerCase()
    .trim()
    .split(/\s+/u)
    .filter(Boolean);
  const matches = (text: string) =>
    terms.every((term) => text.normalize("NFKC").toLowerCase().includes(term));
  const ordered = meetings.toSorted(
    (a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0),
  );
  const localMessages = ordered
    .flatMap((meeting) =>
      meeting.messages.map((message) => ({
        ...message,
        meetingName: meeting.name,
      })),
    )
    .filter(
      (message) =>
        message.role !== "assistant" &&
        message.text &&
        (!sources.length || sources.includes(message.id)) &&
        matches(`${message.authorName ?? message.authorId} ${message.text}`),
    )
    .sort((a, b) => a.at - b.at);
  const messages = loadTranscript
    ? (page?.messages ?? []).toSorted(
        (a, b) => a.at - b.at || a.id.localeCompare(b.id),
      )
    : localMessages.slice(-limit);
  const total = loadTranscript ? (page?.total ?? 0) : localMessages.length;
  const hasMore = loadTranscript ? !!page?.next : localMessages.length > limit;
  const topics = ordered
    .flatMap((meeting) =>
      (meeting.knowledge?.topics ?? []).map((topic) => ({ ...topic, meeting })),
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
  const showSources = (topic: (typeof topics)[number]) => {
    setSources(topic.sourceIds);
    setSourceTopic({ meetingId: topic.meeting.id, topicId: topic.id });
    setQuery("");
    setLimit(Math.max(100, topic.sourceIds.length));
    setTab("transcript");
  };
  return (
    <Stack gap="md">
      {tab !== "document" && (
        <TextInput
          label="議事録・発言を検索"
          placeholder="議題、技術名、発言の一部"
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setLimit(100);
          }}
        />
      )}
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="minutes">議題別の議事録</Tabs.Tab>
          {document && <Tabs.Tab value="document">編集できる議事録</Tabs.Tab>}
          <Tabs.Tab value="transcript">発言ログ</Tabs.Tab>
        </Tabs.List>
        {document && (
          <Tabs.Panel value="document" pt="md">
            {document}
          </Tabs.Panel>
        )}
        <Tabs.Panel value="minutes" pt="md">
          <Stack>
            <Text size="sm" c="dimmed">
              発言から自動整理した議題です。議事録本文への手動編集とは別に更新します。各議題から元の発言を確認できます。
            </Text>
            {!topics.length && (
              <Text c="dimmed">
                {query
                  ? "一致する議題はありません。発言ログも検索できます。"
                  : meetings.some(
                        (meeting) =>
                          meeting.messageCount ?? meeting.messages.length,
                      )
                    ? "発言を保存しています。議題がまとまると、ここに要点・決定事項・未決事項が表示されます。"
                    : "会話が始まると、発言ログと議事録がここに残ります。"}
              </Text>
            )}
            {topics.map((topic) => (
              <Paper key={`${topic.meeting.id}:${topic.id}`} p="md" withBorder>
                <Group justify="space-between" align="flex-start">
                  <Title order={3} size="h4">
                    {topic.title}
                  </Title>
                  <Badge
                    variant="light"
                    color={topic.meeting.closedAt ? "gray" : "teal"}
                  >
                    {topic.meeting.closedAt ? "過去の会議" : "更新中"}
                  </Badge>
                </Group>
                <Text size="xs" c="dimmed" mt={4}>
                  {topic.meeting.name} ·{" "}
                  {new Date(topic.updatedAt).toLocaleString("ja-JP")}
                </Text>
                <Text mt="sm" style={{ whiteSpace: "pre-wrap" }}>
                  {topic.summary}
                </Text>
                {!!topic.decisions.length && (
                  <div>
                    <Text fw={600} size="sm" mt="md">
                      決まったこと
                    </Text>
                    <ul>
                      {topic.decisions.map((text, index) => (
                        <li key={index}>
                          <Text size="sm">{text}</Text>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {!!topic.openQuestions.length && (
                  <div>
                    <Text fw={600} size="sm" mt="md">
                      まだ決まっていないこと
                    </Text>
                    <ul>
                      {topic.openQuestions.map((text, index) => (
                        <li key={index}>
                          <Text size="sm">{text}</Text>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <Button
                  variant="light"
                  size="xs"
                  mt="sm"
                  onClick={() => showSources(topic)}
                >
                  元の発言を見る（{topic.sourceIds.length}件）
                </Button>
              </Paper>
            ))}
          </Stack>
        </Tabs.Panel>
        <Tabs.Panel value="transcript" pt="md">
          <Stack>
            {!!sources.length && (
              <Alert color="blue">
                <Group justify="space-between">
                  <Text size="sm">
                    この議題の根拠になった発言を表示しています。
                  </Text>
                  <Button
                    size="xs"
                    variant="subtle"
                    onClick={() => {
                      setSources([]);
                      setSourceTopic(undefined);
                    }}
                  >
                    すべての発言へ戻る
                  </Button>
                </Group>
              </Alert>
            )}
            <Text size="sm" c="dimmed">
              {total}件の発言
              {total > messages.length ? `のうち直近${messages.length}件` : ""}
              。要約前の言葉を話者・時刻付きで保存しています。
            </Text>
            {error && (
              <Alert color="red">
                履歴を読み込めませんでした。
                <Button variant="subtle" onClick={() => setRetry(retry + 1)}>
                  再試行
                </Button>
              </Alert>
            )}
            {loading && !messages.length && (
              <Text c="dimmed">発言を読み込み中…</Text>
            )}
            {hasMore && (
              <Button
                variant="subtle"
                loading={loading}
                onClick={() =>
                  loadTranscript ? void more() : setLimit(limit + 100)
                }
              >
                以前の発言をさらに表示
              </Button>
            )}
            {!messages.length && !loading && !error && (
              <Text c="dimmed">
                {query
                  ? "一致する発言はありません。別の語句で検索してください。"
                  : "表示できる発言はまだありません。"}
              </Text>
            )}
            {messages.map((message) => (
              <Paper
                key={message.id}
                id={`statement-${message.id}`}
                p="sm"
                withBorder
              >
                <Group justify="space-between">
                  <Text fw={600} size="sm">
                    {message.authorName ?? message.authorId}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {new Date(message.at).toLocaleString("ja-JP")}
                  </Text>
                </Group>
                <Text
                  mt={4}
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {message.text}
                </Text>
                <Text size="xs" c="dimmed" mt={4}>
                  {message.meetingName}
                </Text>
              </Paper>
            ))}
          </Stack>
        </Tabs.Panel>
      </Tabs>
    </Stack>
  );
}
