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
import { useState } from "react";
import type { MeetingView } from "@ido/common/contracts/api";

export function MeetingNotes({ meetings }: { meetings: MeetingView[] }) {
  const [tab, setTab] = useState<string | null>("minutes");
  const [query, setQuery] = useState("");
  const [sources, setSources] = useState<string[]>([]);
  const [limit, setLimit] = useState(100);
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
  const messages = ordered
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
  const showSources = (ids: string[]) => {
    setSources(ids);
    setQuery("");
    setLimit(Math.max(100, ids.length));
    setTab("transcript");
  };
  return (
    <Stack gap="md">
      <TextInput
        label="議事録・発言を検索"
        placeholder="議題、技術名、発言の一部"
        value={query}
        onChange={(event) => {
          setQuery(event.currentTarget.value);
          setLimit(100);
        }}
      />
      <Tabs value={tab} onChange={setTab}>
        <Tabs.List>
          <Tabs.Tab value="minutes">議題別の議事録</Tabs.Tab>
          <Tabs.Tab value="transcript">発言ログ</Tabs.Tab>
        </Tabs.List>
        <Tabs.Panel value="minutes" pt="md">
          <Stack>
            <Text size="sm" c="dimmed">
              会話に合わせて自動更新します。各議題から元の発言を確認できます。
            </Text>
            {!topics.length && (
              <Text c="dimmed">
                {query
                  ? "一致する議題はありません。発言ログも検索できます。"
                  : meetings.some((meeting) => meeting.messages.length)
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
                  onClick={() => showSources(topic.sourceIds)}
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
                    onClick={() => setSources([])}
                  >
                    すべての発言へ戻る
                  </Button>
                </Group>
              </Alert>
            )}
            <Text size="sm" c="dimmed">
              {messages.length}件の発言
              {messages.length > limit ? `のうち直近${limit}件` : ""}
              。要約前の言葉を話者・時刻付きで保存しています。
            </Text>
            {messages.length > limit && (
              <Button variant="subtle" onClick={() => setLimit(limit + 100)}>
                以前の発言をさらに表示
              </Button>
            )}
            {!messages.length && (
              <Text c="dimmed">
                {query
                  ? "一致する発言はありません。別の語句で検索してください。"
                  : "表示できる発言はまだありません。"}
              </Text>
            )}
            {messages.slice(-limit).map((message) => (
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
