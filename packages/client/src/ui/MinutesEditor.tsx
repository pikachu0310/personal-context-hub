import {
  MinutesLiveEditor,
  type MinutesEditorHandle,
} from "./MinutesLiveEditor.js";
import {
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  Select,
  Stack,
  Text,
} from "@mantine/core";
import { useEffect, useRef, useState } from "react";
import {
  MAX_MINUTES_LENGTH,
  taskMarkdown,
  type MeetingView,
  type MinutesUpdateInput,
  type ProjectWorkspace,
  type TaskReference,
} from "@ido/common/contracts/api";
import type { Project } from "@ido/common/contracts/protocol";
import { api } from "./api.js";
import { MinutesMarkdown } from "./MinutesMarkdown.js";
import "./minutes.css";
export function MinutesEditor({
  meeting,
  projectId,
  projects,
  canEdit,
  openTask,
  dirtyChanged,
  saved,
}: {
  meeting: MeetingView;
  projectId: string;
  projects: Project[];
  canEdit: boolean;
  openTask: (reference: TaskReference) => void;
  dirtyChanged: (id: string, dirty: boolean) => void;
  saved: (meeting: MeetingView) => void;
}) {
  const [draft, setDraft] = useState<string>();
  const [base, setBase] = useState({ text: "", revision: 0 });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState<MeetingView>();
  const [picker, setPicker] = useState(false);
  const [linkProject, setLinkProject] = useState(projectId);
  const [choices, setChoices] = useState<ProjectWorkspace["tasks"]>([]);
  const [linkTask, setLinkTask] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const area = useRef<MinutesEditorHandle>(null);
  const selection = useRef({ from: 0, to: 0 });
  const dirty = draft !== undefined && draft !== base.text;
  useEffect(() => {
    dirtyChanged(meeting.id, dirty);
    return () => dirtyChanged(meeting.id, false);
  }, [dirty, dirtyChanged, meeting.id]);
  useEffect(() => {
    if (!picker) return;
    let active = true;
    setChoices([]);
    setLinkTask(null);
    setPickerError("");
    setLoading(true);
    void api<ProjectWorkspace>("project/snapshot", { projectId: linkProject })
      .then((result) => {
        if (active) setChoices(result.tasks);
      })
      .catch((e) => {
        if (active) setPickerError((e as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [picker, linkProject]);
  const begin = () => {
    setDraft(meeting.summary);
    setBase({ text: meeting.summary, revision: meeting.summaryRevision ?? 0 });
    setError("");
    setConflict(undefined);
  };
  const save = async () => {
    if (draft === undefined) return;
    setBusy(true);
    setError("");
    try {
      const input: MinutesUpdateInput = {
        projectId,
        meetingId: meeting.id,
        markdown: draft,
        expectedRevision: base.revision,
      };
      const result = await api<MeetingView>("project/minutes/update", {
        ...input,
      });
      saved(result);
      setDraft(undefined);
      setConflict(undefined);
    } catch (e) {
      setError((e as Error).message);
      try {
        const latest = await api<ProjectWorkspace>("project/snapshot", {
          projectId,
        });
        const value = latest.minutes.find((m) => m.id === meeting.id);
        if (value && (value.summaryRevision ?? 0) !== base.revision)
          setConflict(value);
      } catch {
        /* Keep the draft even if the conflict refresh is offline. */
      }
    } finally {
      setBusy(false);
    }
  };
  const insert = () => {
    const task = choices.find(
      (t) => t.id === linkTask && t.projectId === linkProject,
    );
    if (!task || draft === undefined) return;
    const link = taskMarkdown(
      { projectId: linkProject, taskId: task.id },
      task.title ?? task.text.slice(0, 90),
    );
    area.current?.insert(selection.current.from, selection.current.to, link);
    setPicker(false);
  };
  return (
    <article className="minutes-document" aria-label={meeting.name}>
      <header className="minutes-document-header">
        <div>
          <p className="minutes-eyebrow">MEETING NOTES</p>
          <h2>{meeting.name}</h2>
          <Text size="xs" c="dimmed">
            {meeting.startedAt
              ? new Date(meeting.startedAt).toLocaleString()
              : "日時未設定"}
            {meeting.summaryUpdatedAt &&
              ` · 更新 ${new Date(meeting.summaryUpdatedAt).toLocaleString()}`}
          </Text>
        </div>
        <Group gap="xs">
          <Badge
            variant="light"
            color={meeting.summaryState === "failed" ? "red" : "gray"}
          >
            {meeting.summaryState === "updating"
              ? "自動更新中"
              : meeting.summaryState === "failed"
                ? "自動更新に失敗"
                : meeting.closedAt
                  ? "過去の議事録"
                  : "進行中"}
          </Badge>
          {draft === undefined && canEdit && (
            <Button variant="default" size="xs" onClick={begin}>
              編集
            </Button>
          )}
        </Group>
      </header>
      {meeting.summaryState === "failed" && (
        <Alert color="orange">
          最後に保存した本文を表示しています。次の会話で自動更新を再試行します。
        </Alert>
      )}
      {draft === undefined ? (
        <MinutesMarkdown
          text={
            meeting.summary ||
            ((meeting.messageCount ?? meeting.messages.length)
              ? "議事録をまとめています。議題別の議事録や発言ログから会話を確認できます。"
              : "会話が始まると、ここに議事録がまとまります。")
          }
          openTask={openTask}
        />
      ) : (
        <>
          <Group className="minutes-toolbar" justify="space-between">
            <Button
              variant="light"
              size="xs"
              disabled={busy || !canEdit}
              onClick={() => {
                selection.current = area.current?.selection() ?? {
                  from: draft.length,
                  to: draft.length,
                };
                setLinkProject(projectId);
                setPicker(true);
              }}
            >
              タスクリンクを挿入
            </Button>
            <Text size="xs" c="dimmed">
              {dirty ? "未保存の変更" : "選択した行を編集"} ·{" "}
              {draft.length.toLocaleString()}文字
            </Text>
          </Group>
          <Text size="xs" c="dimmed" mb="sm">
            行を選ぶとMarkdownの原文を編集できます。
          </Text>
          <MinutesLiveEditor
            ref={area}
            value={draft}
            disabled={busy || !canEdit}
            change={setDraft}
            openTask={openTask}
          />
          {(meeting.summaryRevision ?? 0) !== base.revision && !conflict && (
            <Alert color="yellow">
              編集中に新しい版が保存されました。保存時に最新版を確認できます。
            </Alert>
          )}
          {error && (
            <Alert color="red" role="alert">
              {error}
            </Alert>
          )}
          {conflict && (
            <Alert color="yellow" title="最新版を確認してください">
              <Text size="sm">
                入力内容は保持しています。以下の最新版を参照して本文を修正し、再度保存してください。
              </Text>
              <details open>
                <summary>サーバーの最新版</summary>
                <MinutesMarkdown text={conflict.summary} openTask={openTask} />
              </details>
              <Button
                mt="sm"
                variant="default"
                onClick={() => {
                  setBase({
                    text: conflict.summary,
                    revision: conflict.summaryRevision ?? 0,
                  });
                  setConflict(undefined);
                  setError("");
                }}
              >
                最新版を確認しました・編集を続ける
              </Button>
            </Alert>
          )}
          {!canEdit && (
            <Alert color="yellow">
              現在は閲覧専用です。入力内容は保持しています。
            </Alert>
          )}
          <Group justify="flex-end" mt="md">
            <Button
              variant="default"
              disabled={busy}
              onClick={() => {
                if (!dirty || window.confirm("未保存の変更を破棄しますか？")) {
                  setDraft(undefined);
                  setError("");
                  setConflict(undefined);
                }
              }}
            >
              キャンセル
            </Button>
            <Button
              loading={busy}
              disabled={
                !canEdit || !!conflict || draft.length > MAX_MINUTES_LENGTH
              }
              onClick={() => void save()}
            >
              保存
            </Button>
          </Group>
        </>
      )}
      <Modal
        opened={picker}
        onClose={() => setPicker(false)}
        title="タスクリンクを挿入"
        onExitTransitionEnd={() => area.current?.focus()}
      >
        <Stack>
          <Select
            label="プロジェクト"
            searchable
            allowDeselect={false}
            data={projects.map((p) => ({ value: p.id, label: p.name }))}
            value={linkProject}
            onChange={(v) => {
              if (v) setLinkProject(v);
            }}
          />
          <Select
            label="タスク"
            placeholder={loading ? "読み込み中…" : "タスクを検索"}
            searchable
            disabled={loading}
            data={choices.map((t) => ({
              value: t.id,
              label: t.title ?? t.text.slice(0, 90),
            }))}
            value={linkTask}
            onChange={setLinkTask}
            nothingFoundMessage="タスクがありません"
          />
          {pickerError && <Alert color="red">{pickerError}</Alert>}
          <Button disabled={!linkTask || loading} onClick={insert}>
            挿入
          </Button>
        </Stack>
      </Modal>
    </article>
  );
}
