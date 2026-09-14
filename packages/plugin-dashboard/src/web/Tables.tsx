import {
  Badge,
  Button,
  Group,
  Pagination,
  Paper,
  Table,
  Text,
  Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import type { DashboardState, DashboardTask } from "@ido/common/contracts/api";
import {
  color,
  elapsed,
  projectName,
  status,
  time,
  userName,
  type Selection,
} from "./model.js";
export function TablePanel({
  title,
  children,
  detail,
}: {
  title: string;
  children: React.ReactNode;
  detail?: React.ReactNode;
}) {
  return (
    <Paper withBorder radius="sm" className="table-panel">
      <Group className="panel-heading" justify="space-between">
        <Title order={2}>{title}</Title>
        {detail}
      </Group>
      {children}
    </Paper>
  );
}
export function TasksTable({
  state,
  tasks,
  now,
  select,
  compact = false,
}: {
  state: DashboardState;
  tasks: DashboardTask[];
  now: number;
  select: (v: Selection) => void;
  compact?: boolean;
}) {
  const [page, setPage] = useState(1);
  const size = compact ? 6 : 20;
  useEffect(() => setPage(1), [tasks.length, compact]);
  const current = Math.min(page, Math.max(1, Math.ceil(tasks.length / size)));
  return (
    <>
      <Table.ScrollContainer minWidth={860}>
        <Table horizontalSpacing="md" verticalSpacing="sm" highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              {[
                "タスク",
                "プロジェクト",
                "状態",
                "割当ユーザ",
                "実行エージェント",
                "経過",
                "待機理由",
              ].map((v) => (
                <Table.Th key={v}>{v}</Table.Th>
              ))}
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {tasks.slice((current - 1) * size, current * size).map((t) => (
              <Table.Tr key={t.id}>
                <Table.Td>
                  <Button
                    variant="transparent"
                    className="row-link"
                    onClick={() => select({ kind: "task", id: t.id })}
                  >
                    {t.title}
                  </Button>
                  <Text size="xs" c="dimmed" className="identifier">
                    {t.id}
                  </Text>
                </Table.Td>
                <Table.Td>{projectName(state, t.projectId)}</Table.Td>
                <Table.Td>
                  <Badge color={color(t)} variant="light">
                    {status(t)}
                  </Badge>
                </Table.Td>
                <Table.Td>{userName(state, t.userId)}</Table.Td>
                <Table.Td>
                  {state.connections.find((c) => c.id === t.clientId)?.name ??
                    t.clientId ??
                    "—"}
                </Table.Td>
                <Table.Td className="numeric">{elapsed(t, now)}</Table.Td>
                <Table.Td>
                  <Text size="sm" c={t.waitReason ? "orange" : "dimmed"}>
                    {t.waitReason ?? "—"}
                  </Text>
                </Table.Td>
              </Table.Tr>
            ))}
            {!tasks.length && (
              <Table.Tr>
                <Table.Td colSpan={7}>
                  <Text className="empty">該当するタスクはありません</Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </Table.ScrollContainer>
      {tasks.length > size && (
        <Group className="table-footer" justify="space-between">
          <Text size="xs" c="dimmed">
            {tasks.length}件中 {(current - 1) * size + 1}–
            {Math.min(current * size, tasks.length)}件
          </Text>
          <Pagination
            size="xs"
            total={Math.ceil(tasks.length / size)}
            value={current}
            onChange={setPage}
          />
        </Group>
      )}
    </>
  );
}
export function ProjectsTable({
  state,
  projectId,
  select,
}: {
  state: DashboardState;
  projectId: string;
  select: (v: Selection) => void;
}) {
  return (
    <Table.ScrollContainer minWidth={600}>
      <Table horizontalSpacing="md" verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            {[
              "プロジェクト",
              "所属参加者",
              "接続中 / 所属",
              "実行・待機",
              "最終活動",
            ].map((v) => (
              <Table.Th key={v}>{v}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {state.projects
            .filter((p) => !projectId || p.id === projectId)
            .map((p) => (
              <Table.Tr key={p.id}>
                <Table.Td>
                  <Button
                    variant="transparent"
                    className="row-link"
                    onClick={() => select({ kind: "project", id: p.id })}
                  >
                    {p.name}
                  </Button>
                </Table.Td>
                <Table.Td>
                  <Text size="sm" lineClamp={2}>
                    {p.userIds.map((id) => userName(state, id)).join("・") ||
                      "参加者なし"}
                  </Text>
                </Table.Td>
                <Table.Td>
                  {p.connectedUserIds.length} / {p.userIds.length}人
                </Table.Td>
                <Table.Td>
                  {p.running}実行・{p.waiting}待機
                </Table.Td>
                <Table.Td>{time(p.lastActivityAt)}</Table.Td>
              </Table.Tr>
            ))}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
export function UsersTable({
  state,
  query,
  select,
  projectId,
}: {
  state: DashboardState;
  query: string;
  select: (v: Selection) => void;
  projectId: string;
}) {
  const users = state.users.filter(
    (u) =>
      (!projectId ||
        state.connections.some(
          (c) => c.userId === u.id && c.projectIds.includes(projectId),
        )) &&
      `${u.name} ${u.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Table.ScrollContainer minWidth={700}>
      <Table horizontalSpacing="md" verticalSpacing="sm" highlightOnHover>
        <Table.Thead>
          <Table.Tr>
            {[
              "ユーザ",
              "プロジェクト",
              "接続",
              "実行エージェント",
              "実行・待機",
            ].map((v) => (
              <Table.Th key={v}>{v}</Table.Th>
            ))}
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {users.map((u) => {
            const cs = state.connections.filter((c) => c.userId === u.id),
              tasks = state.tasks.filter((t) => t.userId === u.id),
              projects = [...new Set(cs.flatMap((c) => c.projectIds))];
            return (
              <Table.Tr key={u.id}>
                <Table.Td>
                  <Button
                    variant="transparent"
                    className="row-link"
                    onClick={() => select({ kind: "user", id: u.id })}
                  >
                    {u.name}
                  </Button>
                </Table.Td>
                <Table.Td>
                  {projects.map((id) => projectName(state, id)).join("・") ||
                    "—"}
                </Table.Td>
                <Table.Td>
                  <Badge
                    color={cs.some((c) => c.connected) ? "green" : "gray"}
                    variant="light"
                  >
                    {cs.some((c) => c.connected) ? "接続中" : "未接続"}
                  </Badge>
                </Table.Td>
                <Table.Td>{cs.map((c) => c.name).join("・") || "—"}</Table.Td>
                <Table.Td>
                  {tasks.filter((t) => t.state === "running").length}実行・
                  {
                    tasks.filter((t) =>
                      ["queued", "assigned"].includes(t.state),
                    ).length
                  }
                  待機
                </Table.Td>
              </Table.Tr>
            );
          })}
          {!users.length && (
            <Table.Tr>
              <Table.Td colSpan={5}>
                <Text className="empty">該当するユーザはいません</Text>
              </Table.Td>
            </Table.Tr>
          )}
        </Table.Tbody>
      </Table>
    </Table.ScrollContainer>
  );
}
