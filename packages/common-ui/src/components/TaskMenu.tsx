import { Icon } from "./Icon.js";
import { Button, Group, Menu, Modal, Stack, Text } from "@mantine/core";
import { useState } from "react";
import type { Task } from "@ido/common/contracts/protocol";
import type { Action } from "../types.js";
export const lifecycleError = (error: unknown) => {
  const code = error instanceof Error ? error.message : String(error);
  return (
    (
      {
        WORKSPACE_CONFLICT:
          "状態が変わりました。キャンセルして最新の状態を確認し、もう一度操作してください。",
        TASK_ACTIVE:
          "実行中、または停止確認待ちのタスクは削除できません。停止・完了後に操作してください。",
        PROJECT_TASKS_ACTIVE:
          "実行中、または停止確認待ちのタスクがあります。対象タスクを停止・完了してから操作してください。",
        OWNER_TRANSFER_REQUIRED:
          "退出する前に、既存の参加者へowner権限を移譲してください。",
        DEFAULT_PROJECT_DELETE_FORBIDDEN:
          "デフォルトプロジェクトは完全削除できません。",
        PERMISSION_DENIED: "この操作を行う権限がありません。",
        TASK_NOT_FOUND:
          "タスクはすでに削除されています。最新の状態に更新してください。",
      } as Record<string, string>
    )[code] ?? code
  );
};
export function TaskMenu({
  task,
  actorId,
  action,
  disabled = false,
}: {
  task: Pick<
    Task,
    | "id"
    | "text"
    | "title"
    | "revision"
    | "controlVersion"
    | "membershipVersion"
    | "participants"
    | "memberStates"
    | "canDelete"
  >;
  actorId?: string;
  action: Action;
  disabled?: boolean;
}) {
  const [confirm, setConfirm] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [deletionInput, setDeletionInput] = useState<Record<string, unknown>>();
  const joined =
    task.participants?.some((p) => p.id === actorId) ??
    task.memberStates?.[actorId ?? ""] === true;
  const input = {
    taskId: task.id,
    revision: task.revision,
    controlVersion: task.controlVersion ?? 0,
    membershipVersion: task.membershipVersion ?? 0,
  };
  const apply = async (operation: string) => {
    setBusy(true);
    setError("");
    try {
      await action(operation, {
        ...(operation === "task/delete" ? deletionInput : input),
        confirm: true,
      });
      setConfirm(false);
    } catch (e) {
      setError(lifecycleError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Menu withinPortal position="bottom-end">
        <Menu.Target>
          <button
            className="icon-button"
            disabled={disabled || busy}
            aria-label={`${task.title ?? task.text}のタスクメニュー`}
          >
            <Icon name="dots" />
          </button>
        </Menu.Target>
        <Menu.Dropdown>
          {actorId && (
            <Menu.Item
              onClick={() => void apply(joined ? "task/leave" : "task/join")}
            >
              {joined ? "退出" : "参加する"}
            </Menu.Item>
          )}
          {task.canDelete && (
            <Menu.Item
              color="red"
              onClick={() => {
                setError("");
                setDeletionInput(input);
                setConfirm(true);
              }}
            >
              削除
            </Menu.Item>
          )}
          {!actorId && !task.canDelete && (
            <Menu.Item disabled>操作権限がありません</Menu.Item>
          )}
        </Menu.Dropdown>
      </Menu>
      <Modal
        centered
        opened={confirm || !!error}
        onClose={() => {
          if (!busy) {
            setConfirm(false);
            setError("");
          }
        }}
        title={confirm ? "タスクを完全に削除" : "操作できませんでした"}
        closeOnClickOutside={!busy}
        closeOnEscape={!busy}
      >
        <Stack>
          {confirm && (
            <>
              <Text fw={600}>{task.title ?? task.text}</Text>
              <Text>
                全ユーザーからタスクと履歴が消え、元に戻せません。指示・結果・参加情報・プレビュー・IDOのAIコンテキストを削除します。
              </Text>
              <Text size="sm" c="dimmed">
                元の共有会話・議事録、Gitフォルダ、外部サービスへの投稿は残ります。オフライン端末のローカル履歴は再接続後に整理されます。
              </Text>
            </>
          )}
          {error && (
            <Text c="red" role="alert">
              {error}
            </Text>
          )}
          <Group justify="flex-end">
            <Button
              data-autofocus
              variant="default"
              disabled={busy}
              onClick={() => {
                setConfirm(false);
                setError("");
              }}
            >
              キャンセル
            </Button>
            {confirm && (
              <Button
                color="red"
                loading={busy}
                disabled={disabled}
                onClick={() => void apply("task/delete")}
              >
                完全に削除する
              </Button>
            )}
          </Group>
        </Stack>
      </Modal>
    </>
  );
}
