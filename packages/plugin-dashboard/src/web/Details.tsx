import { TaskMenu, ProjectManagement } from "@ido/common-ui";
import {
  Alert,
  Badge,
  Button,
  Divider,
  Drawer,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useState } from "react";
import type {
  DashboardState,
  DashboardTask,
  DashboardConnection,
} from "@ido/common/contracts/api";
import { api } from "./api.js";
import {
  color,
  dateTime,
  isActive,
  projectName,
  status,
  stopping,
  userName,
  type Selection,
} from "./model.js";
const Field = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="detail-field">
    <Text c="dimmed" size="sm">
      {label}
    </Text>
    <Text size="sm">{value}</Text>
  </div>
);
export function Details({
  state,
  selection,
  close,
  select,
  stale,
  refresh,
  openRaw,
}: {
  state: DashboardState;
  selection?: Selection;
  close: () => void;
  select: (v: Selection) => void;
  stale: boolean;
  refresh: () => Promise<void>;
  openRaw: (id: string) => void;
}) {
  const [confirm, setConfirm] = useState<{
    task?: DashboardTask;
    connection?: DashboardConnection;
    tasks: DashboardTask[];
    requestId: string;
  }>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState("");
  const task =
    selection?.kind === "task"
      ? state.tasks.find((t) => t.id === selection.id)
      : undefined;
  const user =
    selection?.kind === "user"
      ? state.users.find((u) => u.id === selection.id)
      : undefined;
  const project =
    selection?.kind === "project"
      ? state.projects.find((p) => p.id === selection.id)
      : undefined;
  const taskItems = (tasks: DashboardTask[]) => (
    <Stack gap="xs">
      {tasks.length ? (
        tasks.map((t) => (
          <Paper withBorder p="sm" key={t.id}>
            <Group justify="space-between" wrap="nowrap">
              <Button
                className="row-link"
                variant="transparent"
                onClick={() => select({ kind: "task", id: t.id })}
              >
                {t.title}
              </Button>
              <Badge color={color(t)}>{status(t)}</Badge>
            </Group>
            <Text size="xs" c="dimmed">
              {projectName(state, t.projectId)}
            </Text>
          </Paper>
        ))
      ) : (
        <Text size="sm" c="dimmed">
          担当タスクなし
        </Text>
      )}
    </Stack>
  );
  const execute = async () => {
    if (!confirm || stale) return;
    setBusy(true);
    setError("");
    setResult("");
    try {
      if (confirm.task) {
        await api("stop", {
          taskId: confirm.task.id,
          runId: confirm.task.runId,
          revision: confirm.task.revision,
          controlVersion: confirm.task.controlVersion,
          requestId: confirm.requestId,
        });
        setResult("停止要求を受け付けました。タスクの停止確認を待っています。");
      } else if (confirm.connection) {
        const response = await api<{
          disconnected: boolean;
          unconfirmedTaskIds: string[];
        }>("disconnect", {
          deviceId: confirm.connection.id,
          generation: confirm.connection.generation,
          tasks: confirm.tasks.map((t) => ({
            id: t.id,
            runId: t.runId,
            revision: t.revision,
            controlVersion: t.controlVersion,
          })),
        });
        setResult(
          response.unconfirmedTaskIds.length
            ? `接続を切断しました。${response.unconfirmedTaskIds.length}件のタスクは停止未確認です。端末で確認してください。`
            : "接続を切断しました。対象タスクの停止を確認しました。再接続できます。",
        );
      }
      setConfirm(undefined);
    } catch (e) {
      setError(
        `${(e as Error).message} — 状態を再取得し、対象を確認してください。通信エラーの場合は結果未確認です。`,
      );
    } finally {
      await refresh();
      setBusy(false);
    }
  };
  const start = (value: Omit<NonNullable<typeof confirm>, "requestId">) => {
    setError("");
    setResult("");
    setConfirm({ ...value, requestId: crypto.randomUUID() });
  };
  const startConnection = async (connection: DashboardConnection) => {
    setError("");
    setResult("");
    try {
      // A connection can serve several projects. Confirm its full impact even when the list is filtered.
      const response = await fetch("/api/admin/dashboard", {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("接続情報を取得できません");
      const all = (await response.json()) as DashboardState;
      const current = all.connections.find(
        (c) =>
          c.id === connection.id &&
          c.generation === connection.generation &&
          c.connected,
      );
      if (!current) throw new Error("接続が変わりました");
      start({
        connection: current,
        tasks: all.tasks.filter(
          (t) =>
            t.clientId === current.id &&
            ["assigned", "running", "interrupted"].includes(t.state),
        ),
      });
    } catch (e) {
      setResult((e as Error).message);
    }
  };
  const changed =
    !!confirm &&
    (confirm.task
      ? !state.tasks.some(
          (t) =>
            t.id === confirm.task!.id &&
            t.runId === confirm.task!.runId &&
            t.revision === confirm.task!.revision &&
            t.controlVersion === confirm.task!.controlVersion &&
            isActive(t),
        )
      : !state.connections.some(
          (c) =>
            c.id === confirm.connection?.id &&
            c.generation === confirm.connection.generation &&
            c.connected,
        ));
  return (
    <>
      <Drawer
        opened={!!selection}
        onClose={() => {
          if (!busy) {
            close();
            setResult("");
          }
        }}
        position="right"
        size={500}
        title={
          selection?.kind === "task"
            ? "タスク詳細"
            : selection?.kind === "user"
              ? "ユーザ詳細"
              : "プロジェクト詳細"
        }
        padding="lg"
        overlayProps={{ backgroundOpacity: 0.12 }}
      >
        <Stack gap="lg">
          {stale && (
            <Alert color="yellow">
              通信状態を確認しています。管理操作は利用できません。
            </Alert>
          )}
          {result && (
            <Alert
              color={result.includes("未確認") ? "yellow" : "blue"}
              role="status"
            >
              {result}
            </Alert>
          )}
          {task && (
            <>
              <Title order={3}>{task.title}</Title>
              <Badge color={color(task)}>{status(task)}</Badge>
              <Field label="タスクID" value={task.id} />
              <Field
                label="プロジェクト"
                value={projectName(state, task.projectId)}
              />
              <Field
                label="発生元の会話"
                value={
                  <Button
                    className="row-link"
                    variant="transparent"
                    onClick={() => openRaw(task.meetingId)}
                  >
                    {state.meetings.find((m) => m.id === task.meetingId)
                      ?.name ?? task.meetingId}
                  </Button>
                }
              />
              <Field label="割当ユーザ" value={userName(state, task.userId)} />
              <Field
                label="実行エージェント"
                value={
                  state.connections.find((c) => c.id === task.clientId)?.name ??
                  task.clientId ??
                  "未割当"
                }
              />
              <Field
                label="割当理由"
                value={task.assignmentReason ?? "未取得"}
              />
              <Field label="待機理由" value={task.waitReason ?? "—"} />
              <Divider />
              <Title order={4}>状態の記録</Title>
              <Field label="作成" value={dateTime(task.createdAt)} />
              <Field label="割当" value={dateTime(task.assignedAt)} />
              <Field label="最終更新" value={dateTime(task.updatedAt)} />
              <Field label="実行版" value={task.revision} />
              <Button variant="subtle" onClick={() => openRaw(task.id)}>
                操作履歴を生データで確認
              </Button>
              {stopping(task) && (
                <Alert color="yellow">
                  停止要求中です。クライアントから停止確認が届くまで完了扱いにしません。
                </Alert>
              )}
              <Divider />
              <Title order={4}>管理操作</Title>
              <TaskMenu
                task={{ ...task, text: task.title, canDelete: true }}
                disabled={stale}
                action={async (path, input) => {
                  const result = await api<
                    import("@ido/common/contracts/api").ApiResult
                  >(path, input);
                  await refresh();
                  return result;
                }}
              />
              <Button
                color="red"
                variant="outline"
                disabled={stale || busy || !isActive(task) || !!stopping(task)}
                onClick={() => start({ task, tasks: [] })}
              >
                タスクを強制停止
              </Button>
            </>
          )}
          {user && (
            <>
              <Title order={3}>{user.name}</Title>
              <Text c="dimmed" size="sm">
                登録ユーザ
              </Text>
              <Title order={4}>参加プロジェクト</Title>
              <Group gap="xs">
                {[
                  ...new Set(
                    state.connections
                      .filter((c) => c.userId === user.id)
                      .flatMap((c) => c.projectIds),
                  ),
                ].map((id) => (
                  <Button
                    key={id}
                    variant="light"
                    size="xs"
                    onClick={() => select({ kind: "project", id })}
                  >
                    {projectName(state, id)}
                  </Button>
                ))}
              </Group>
              <Divider />
              <Title order={4}>現在の接続</Title>
              {state.connections
                .filter((c) => c.userId === user.id)
                .map((c) => (
                  <Paper key={c.id} withBorder p="md">
                    <Stack gap="sm">
                      <Group justify="space-between">
                        <Text fw={600}>{c.name}</Text>
                        <Badge
                          color={
                            c.disconnecting
                              ? "orange"
                              : c.connected
                                ? "green"
                                : "gray"
                          }
                        >
                          {c.disconnecting
                            ? "切断要求中"
                            : c.connected
                              ? "接続中"
                              : "未接続"}
                        </Badge>
                      </Group>
                      <Field label="実行エージェントID" value={c.id} />
                      <Field label="接続世代" value={c.generation} />
                      <Field label="接続開始" value={dateTime(c.connectedAt)} />
                      <Field label="最終応答" value={dateTime(c.lastSeenAt)} />
                      <Field label="実行枠" value={c.slots} />
                      <Text size="xs" c="dimmed">
                        {c.ready
                          ? "実行を受け付けています"
                          : "現在は新しい実行を受け付けていません"}
                      </Text>
                      <Button
                        color="red"
                        variant="outline"
                        disabled={
                          stale || busy || !c.connected || c.disconnecting
                        }
                        onClick={() => void startConnection(c)}
                      >
                        この接続を切断
                      </Button>
                    </Stack>
                  </Paper>
                ))}
              {!state.connections.some((c) => c.userId === user.id) && (
                <Text c="dimmed">登録された実行エージェントはありません</Text>
              )}
              <Text size="xs" c="dimmed">
                再接続できます。登録・所属は維持されます。
              </Text>
              <Title order={4}>担当タスク</Title>
              {taskItems(
                state.tasks.filter((t) => t.userId === user.id && isActive(t)),
              )}
            </>
          )}
          {project && (
            <>
              <Title order={3}>{project.name}</Title>
              <ProjectManagement
                project={project}
                disabled={stale}
                action={async (path, input) => {
                  const result = await api<
                    import("@ido/common/contracts/api").ApiResult
                  >(path, input);
                  await refresh();
                  return result;
                }}
              />
              <Field label="プロジェクトID" value={project.id} />
              <Field
                label="接続中 / 所属"
                value={`${project.connectedUserIds.length} / ${project.userIds.length}人`}
              />
              <Title order={4}>所属参加者</Title>
              {project.userIds.length ? (
                project.userIds.map((id) => (
                  <Group key={id} justify="space-between">
                    <Button
                      variant="transparent"
                      onClick={() => select({ kind: "user", id })}
                    >
                      {userName(state, id)}
                    </Button>
                    <Badge
                      color={
                        project.connectedUserIds.includes(id) ? "green" : "gray"
                      }
                    >
                      {project.connectedUserIds.includes(id)
                        ? "接続中"
                        : "未接続"}
                    </Badge>
                  </Group>
                ))
              ) : (
                <Text c="dimmed">所属参加者はいません</Text>
              )}
              <Title order={4}>会話</Title>
              {state.meetings
                .filter((m) => m.projectId === project.id)
                .map((m) => (
                  <Button
                    key={m.id}
                    variant="subtle"
                    onClick={() => openRaw(m.id)}
                  >
                    {m.name}
                  </Button>
                ))}
              <Title order={4}>タスク</Title>
              {taskItems(
                state.tasks.filter(
                  (t) => t.projectId === project.id && isActive(t),
                ),
              )}
            </>
          )}
          {!task && !user && !project && (
            <Text c="dimmed">対象は現在の表示範囲にありません。</Text>
          )}
        </Stack>
      </Drawer>
      <Modal
        opened={!!confirm}
        onClose={() => {
          if (!busy) setConfirm(undefined);
        }}
        centered
        title={
          confirm?.task
            ? "このタスクを強制停止しますか？"
            : "この接続を切断しますか？"
        }
        closeOnClickOutside={!busy}
        closeOnEscape={!busy}
        withCloseButton={!busy}
      >
        {confirm && (
          <Stack gap="md">
            {confirm.task ? (
              <>
                <Text fw={600}>{confirm.task.title}</Text>
                <Field
                  label="実行先"
                  value={
                    state.connections.find(
                      (c) => c.id === confirm.task?.clientId,
                    )?.name ?? "未割当"
                  }
                />
                <Text size="sm">
                  この実行の停止を要求します。履歴は保持されます。
                </Text>
              </>
            ) : (
              <>
                <Text fw={600}>{confirm.connection?.name}</Text>
                <Field
                  label="対象ユーザ"
                  value={userName(state, confirm.connection?.userId)}
                />
                <Field
                  label="対象接続"
                  value={`${confirm.connection?.id} / 世代 ${confirm.connection?.generation}`}
                />
                <Text size="sm">
                  対象接続の実行を停止し、接続を切断します。
                </Text>
                {confirm.tasks.map((t) => (
                  <Text size="sm" key={t.id}>
                    • {t.title}（{status(t)}）
                  </Text>
                ))}
                {!confirm.tasks.length && (
                  <Text size="sm">対象接続で進行中のタスクはありません。</Text>
                )}
                <Text size="sm">
                  待機中の未割当タスクは削除せず保持します。ユーザは再接続できます。登録・所属は変更しません。
                </Text>
              </>
            )}
            {error && <Alert color="red">{error}</Alert>}
            {changed && (
              <Alert color="yellow">
                対象の状態が変わりました。閉じて最新の状態を確認してください。
              </Alert>
            )}
            {stale && <Alert color="yellow">接続を確認できません。</Alert>}
            <Group justify="flex-end">
              <Button
                variant="default"
                disabled={busy}
                onClick={() => setConfirm(undefined)}
              >
                キャンセル
              </Button>
              <Button
                color="red"
                loading={busy}
                disabled={stale || changed}
                onClick={() => void execute()}
              >
                {confirm.task ? "タスクを強制停止" : "接続を切断"}
              </Button>
            </Group>
          </Stack>
        )}
      </Modal>
    </>
  );
}
