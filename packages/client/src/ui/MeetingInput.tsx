import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Paper,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import { meetingAudio } from "./meeting-audio.js";
import { stateLabel } from "./ActivityFeed.js";
import type { TaskReference } from "@ido/common/contracts/api";

type Entry = {
  id: number;
  at: number;
  kind: "transcript" | "reply" | "audio" | "notice" | "error";
  text?: string;
  audio?: string;
};
type MeetingResponse = {
  accepted?: boolean;
  entries: Entry[];
  pending: number;
  tasks?: Array<TaskReference & { title: string; state: string }>;
};

export function MeetingInput({
  projectId,
  connected,
  openTask,
}: {
  projectId: string;
  connected: boolean;
  openTask: (task: TaskReference) => void;
}) {
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [pending, setPending] = useState(0);
  const [tasks, setTasks] = useState<NonNullable<MeetingResponse["tasks"]>>([]);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordSeconds, setRecordSeconds] = useState(0);
  const [audioReplies, setAudioReplies] = useState(false);
  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const discard = useRef(false);
  const alive = useRef(true);
  const request = useRef<
    { key: string; text?: string; audio?: string } | undefined
  >(undefined);
  const pendingAudio = useRef<string | undefined>(undefined);
  const [audioRetry, setAudioRetry] = useState(false);
  const update = (value: MeetingResponse) => {
    if (alive.current) {
      setEntries(value.entries);
      setPending(value.pending);
      setTasks(value.tasks ?? []);
    }
  };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      discard.current = true;
      clearInterval(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      stream.current?.getTracks().forEach((track) => track.stop());
    };
  }, []);
  useEffect(() => {
    if (!connected) return;
    let active = true;
    const refresh = async () => {
      try {
        const value = await api<MeetingResponse>("project/meeting-read", {
          projectId,
          audioReplies,
        });
        if (active) {
          update(value);
          setPollError("");
        }
      } catch (cause) {
        if (active) setPollError((cause as Error).message);
      }
    };
    void refresh();
    const interval = setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [projectId, connected, audioReplies]);

  async function send(content: { text?: string; audio?: string }) {
    if (!connected) {
      setError("Engineへ接続してから発言してください。");
      return;
    }
    if (
      request.current?.text !== content.text ||
      request.current?.audio !== content.audio ||
      !request.current
    )
      request.current = { key: crypto.randomUUID(), ...content };
    setSending(true);
    setError("");
    try {
      const value = await api<MeetingResponse>("project/meeting-input", {
        projectId,
        requestId: request.current.key,
        ...content,
        audioReplies,
      });
      update(value);
      if (alive.current) {
        if (content.text) setDraft("");
        setAudioRetry(false);
      }
      pendingAudio.current = undefined;
      request.current = undefined;
    } catch (cause) {
      if (alive.current) {
        setError((cause as Error).message);
        setAudioRetry(!!content.audio);
      }
      pendingAudio.current = content.audio;
    } finally {
      if (alive.current) setSending(false);
    }
  }

  function stop(cancel = false) {
    discard.current = cancel;
    clearInterval(timer.current);
    if (recorder.current?.state === "recording") recorder.current.stop();
    stream.current?.getTracks().forEach((track) => track.stop());
    setRecording(false);
    if (!cancel) setSending(true);
  }

  async function record() {
    setError("");
    setSending(true);
    try {
      if (
        !navigator.mediaDevices?.getUserMedia ||
        typeof MediaRecorder === "undefined"
      )
        throw new Error(
          "このブラウザでは録音を利用できません。文章で発言できます。",
        );
      const capture = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          channelCount: 1,
        },
      });
      if (!alive.current) {
        capture.getTracks().forEach((track) => track.stop());
        return;
      }
      stream.current = capture;
      const media = new MediaRecorder(capture);
      const chunks: Blob[] = [];
      discard.current = false;
      recorder.current = media;
      media.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      media.onerror = () => {
        stop(true);
        setSending(false);
        setError("録音できませんでした。マイクの接続を確認してください。");
      };
      media.onstop = async () => {
        if (discard.current || !alive.current) return;
        try {
          const audio = await meetingAudio(
            new Blob(chunks, { type: media.mimeType }),
          );
          if (alive.current) await send({ audio });
        } catch (cause) {
          if (alive.current) {
            setSending(false);
            setError((cause as Error).message);
          }
        }
      };
      media.start();
      setRecordSeconds(0);
      setRecording(true);
      setSending(false);
      const started = Date.now();
      timer.current = setInterval(() => {
        const seconds = Math.floor((Date.now() - started) / 1000);
        setRecordSeconds(seconds);
        if (seconds >= 12) stop();
      }, 250);
    } catch (cause) {
      stream.current?.getTracks().forEach((track) => track.stop());
      if (alive.current) {
        setSending(false);
        setError(
          (cause as Error).name === "NotAllowedError"
            ? "マイクの使用が許可されませんでした。ブラウザの設定から許可するか、文章で発言できます。"
            : (cause as Error).message,
        );
      }
    }
  }

  return (
    <Stack gap="md">
      <Text c="dimmed" size="sm">
        このプロジェクトの会議へ発言します。議事録に残り、内容に応じてAIが返答や試作を進めます。
      </Text>
      {!connected && (
        <Alert color="yellow">Engineへの接続を待っています。</Alert>
      )}
      {error && <Alert color="red">{error}</Alert>}
      {pollError && <Alert color="yellow">{pollError}</Alert>}
      <Textarea
        label="会議で話したいこと"
        placeholder="ワープ移動と連続移動を比べたい。触れる小さな試作を作ってもらえますか？"
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        autosize
        minRows={3}
        maxRows={7}
        maxLength={16000}
        disabled={recording}
      />
      <Group justify="space-between">
        <Group>
          {recording ? (
            <>
              <Button color="red" onClick={() => stop()}>
                録音を止めて送信 · {recordSeconds}/12秒
              </Button>
              <Button variant="subtle" onClick={() => stop(true)}>
                録音を破棄
              </Button>
            </>
          ) : (
            <Button
              variant="light"
              onClick={() => void record()}
              disabled={!connected || sending || pending >= 2}
            >
              マイクで話す
            </Button>
          )}
          <Text size="xs" c="dimmed">
            最大12秒。停止すると会議へ送信します。
          </Text>
        </Group>
        <Button
          onClick={() => void send({ text: draft.trim() })}
          disabled={
            !connected || !draft.trim() || recording || sending || pending >= 2
          }
          loading={sending}
        >
          会議へ送る
        </Button>
      </Group>
      {audioRetry && (
        <Group>
          <Text size="sm">送れなかった音声を保持しています。</Text>
          <Button
            variant="light"
            disabled={sending || !connected}
            onClick={() =>
              pendingAudio.current && void send({ audio: pendingAudio.current })
            }
          >
            同じ音声を再送
          </Button>
          <Button
            variant="subtle"
            onClick={() => {
              pendingAudio.current = undefined;
              request.current = undefined;
              setAudioRetry(false);
            }}
          >
            破棄
          </Button>
        </Group>
      )}
      <Group justify="space-between">
        <Text fw={650}>この画面からの発言と返答</Text>
        <Checkbox
          checked={audioReplies}
          onChange={(event) => setAudioReplies(event.currentTarget.checked)}
          label="返答の音声も表示"
        />
      </Group>
      {pending > 0 && (
        <Text size="sm" role="status">
          {pending}件の発言を会議へ反映しています…
        </Text>
      )}
      {!!tasks.length && (
        <section
          className="meeting-browser-tasks"
          aria-label="会議から進んだ作業"
        >
          <Text fw={650} size="sm">
            会議から進んだ作業
          </Text>
          <Text size="xs" c="dimmed">
            この画面を開いてから作成・更新された、このプロジェクトのタスクです。
          </Text>
          {tasks.map((task) => (
            <Paper key={task.taskId} p="sm" withBorder>
              <Group justify="space-between" wrap="nowrap">
                <div style={{ minWidth: 0 }}>
                  <Text size="sm" fw={600} lineClamp={2}>
                    {task.title}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {stateLabel(task.state)}
                  </Text>
                </div>
                <Button
                  size="xs"
                  variant="light"
                  onClick={() => openTask(task)}
                >
                  タスクを開く
                </Button>
              </Group>
            </Paper>
          ))}
        </section>
      )}
      <div className="meeting-browser-entries" aria-live="polite">
        {!entries.length && (
          <Text c="dimmed" size="sm">
            まずは一言、いま考えている案を伝えてみてください。
          </Text>
        )}
        {entries.map((entry) => (
          <Paper
            key={entry.id}
            p="sm"
            withBorder
            className={`meeting-browser-entry meeting-browser-entry-${entry.kind}`}
          >
            <Group justify="space-between" mb={entry.text ? "xs" : 0}>
              <Badge
                variant="light"
                color={
                  entry.kind === "reply" || entry.kind === "audio"
                    ? "blue"
                    : "gray"
                }
              >
                {entry.kind === "transcript"
                  ? "あなたの発言"
                  : entry.kind === "reply" || entry.kind === "audio"
                    ? "IDO"
                    : "受付"}
              </Badge>
              <Text size="xs" c="dimmed">
                {new Date(entry.at).toLocaleTimeString("ja-JP", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </Text>
            </Group>
            {entry.text && (
              <Text size="sm" style={{ whiteSpace: "pre-wrap" }}>
                {entry.text}
              </Text>
            )}
            {entry.audio && (
              <audio
                controls
                preload="none"
                src={`data:audio/ogg;base64,${entry.audio}`}
                aria-label="IDOの音声返答"
              />
            )}
          </Paper>
        ))}
      </div>
      <Text size="xs" c="dimmed">
        会議全体の記録は議事録から確認できます。マイクはボタンを押したときだけ使い、この画面を閉じると録音を破棄して停止します。
      </Text>
    </Stack>
  );
}
