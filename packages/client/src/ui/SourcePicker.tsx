import {
  Alert,
  Button,
  Menu,
  Modal,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@mantine/core";
import { useEffect, useState, useRef } from "react";
import type {
  ProjectWorkspace,
  TaskContextSource,
} from "@ido/common/contracts/api";
import { api } from "./api.js";
import { Icon } from "./Icons.js";
export interface SourceTarget {
  taskId: string;
  projectId: string;
  runId?: string;
}
export function SourcePicker({
  target,
  onSources,
}: {
  target: SourceTarget;
  onSources: (sources: TaskContextSource[]) => void;
}) {
  const requestId = useRef(crypto.randomUUID());
  const [kind, setKind] = useState<"minutes" | "context">();
  const [meetings, setMeetings] = useState<ProjectWorkspace["minutes"]>([]);
  const [meetingId, setMeetingId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let active = true;
    api<{ sources: TaskContextSource[] }>("task/sources", { ...target })
      .then((result) => {
        if (active) onSources(result.sources);
      })
      .catch(() => {
        /* Existing execution sources remain available offline. */
      });
    return () => {
      active = false;
    };
  }, [target.taskId, target.runId, target.projectId, onSources]);
  async function open(next: "minutes" | "context") {
    requestId.current = crypto.randomUUID();
    setKind(next);
    setError("");
    setTitle("");
    setBody("");
    setMeetingId(null);
    if (next !== "minutes") return;
    setLoading(true);
    setMeetings([]);
    try {
      const result = await api<ProjectWorkspace>("project/snapshot", {
        projectId: target.projectId,
      });
      setMeetings(result.minutes);
    } catch {
      setError(
        "議事録を取得できませんでした。プロジェクトへの接続を確認してください。",
      );
    } finally {
      setLoading(false);
    }
  }
  async function add() {
    const meeting = meetings.find((item) => item.id === meetingId);
    const sourceText = kind === "minutes" ? meeting?.summary : body;
    if (!sourceText?.trim()) return;
    if (sourceText.length > 16000) {
      setError(
        "1件のソースは16,000文字までです。必要な部分を共有コンテキストとして追加してください。",
      );
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api<{ sources: TaskContextSource[] }>(
        "task/sources",
        {
          ...target,
          sourceId: kind === "minutes" ? meeting!.id : requestId.current,
          kind,
          title: kind === "minutes" ? meeting!.name : title.trim(),
          text: sourceText,
        },
      );
      onSources(result.sources);
      setKind(undefined);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <button className="icon-button" aria-label="ソースを追加">
            <Icon name="plus" />
          </button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item
            leftSection={<Icon name="file" />}
            onClick={() => void open("minutes")}
          >
            議事録
          </Menu.Item>
          <Menu.Item
            leftSection={<Icon name="folder" />}
            onClick={() => void open("context")}
          >
            共有コンテキスト
          </Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <Modal
        opened={!!kind}
        onClose={() => {
          if (!busy) setKind(undefined);
        }}
        title={kind === "minutes" ? "議事録を追加" : "共有コンテキストを追加"}
        centered
      >
        <Stack>
          <Text size="sm" c="dimmed">
            資料のコピーをこのタスクに保存します。追加だけでは実行を開始しません。次回の実行で参照されます。
          </Text>
          {target.runId && (
            <Text size="sm" c="dimmed">
              このPCのタスクに保存されます。
            </Text>
          )}
          {error && <Alert color="red">{error}</Alert>}
          {kind === "minutes" ? (
            <>
              <Select
                label="議事録"
                placeholder={loading ? "読み込み中…" : "議事録を選択"}
                searchable
                disabled={loading || busy}
                value={meetingId}
                onChange={setMeetingId}
                data={meetings.map((item) => ({
                  value: item.id,
                  label: item.name,
                  disabled: !item.summary.trim(),
                }))}
                nothingFoundMessage="追加できる議事録がありません"
              />
              {meetingId && (
                <Text size="sm" className="source-picker-preview">
                  {meetings.find((item) => item.id === meetingId)?.summary}
                </Text>
              )}
              {!loading &&
                !error &&
                !meetings.some((item) => item.summary.trim()) && (
                  <Text size="sm">要約のある議事録がまだありません。</Text>
                )}
            </>
          ) : (
            <>
              <TextInput
                label="タイトル"
                value={title}
                onChange={(e) => setTitle(e.currentTarget.value)}
                maxLength={200}
                required
              />
              <Textarea
                label="内容"
                value={body}
                onChange={(e) => setBody(e.currentTarget.value)}
                maxLength={16000}
                minRows={6}
                autosize
                required
              />
            </>
          )}
          <Button
            onClick={() => void add()}
            loading={busy}
            disabled={
              kind === "minutes"
                ? !meetingId || loading
                : !title.trim() || !body.trim()
            }
          >
            追加する
          </Button>
        </Stack>
      </Modal>
    </>
  );
}
