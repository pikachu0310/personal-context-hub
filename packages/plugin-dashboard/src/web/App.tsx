import {
  ActionIcon,
  Alert,
  Anchor,
  AppShell,
  Badge,
  Burger,
  Button,
  Group,
  Loader,
  NavLink,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core";
import { useState } from "react";
import type { DashboardState } from "@ido/common/contracts/api";
import { useRemoteState } from "./useRemoteState.js";
import { attention, isActive, time, type Selection } from "./model.js";
import { TablePanel, TasksTable, ProjectsTable, UsersTable } from "./Tables.js";
import { Details } from "./Details.js";
import { RawData } from "./RawData.js";
import "./dashboard.css";
const pages = [
  ["overview", "概要"],
  ["tasks", "タスク"],
  ["users", "ユーザ・接続"],
  ["projects", "プロジェクト"],
  ["raw", "生データ"],
];
function NavIcon({ kind }: { kind: string }) {
  const paths: Record<string, string> = {
    refresh:
      "M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 3l1 3M4 12l1 3a8 8 0 0 0 13 3",
    overview: "M3 11 12 3l9 8M5 10v11h14V10M9 21v-7h6v7",
    tasks: "M8 6h13M8 12h13M8 18h13M3 6h.1M3 12h.1M3 18h.1",
    users:
      "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M17 4a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-4",
    projects: "M3 7h6l2-3h10v16H3ZM3 8h18",
    raw: "M4 5h16v15H4ZM8 9h8M8 13h8M8 17h4",
  };
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[kind]} />
      {kind === "users" && <circle cx="9" cy="7" r="4" />}
    </svg>
  );
}
function Activity({ state }: { state: DashboardState }) {
  const a = state.activity,
    max = Math.max(5, ...a.buckets.map((b) => b.count));
  return (
    <TablePanel
      title="会話量"
      detail={
        <Badge variant="light" color="gray">
          直近60分
        </Badge>
      }
    >
      <div className="activity">
        <Text size="xs" c="dimmed">
          確定した人の発言件数 / 5分
        </Text>
        <svg
          viewBox="0 0 520 165"
          role="img"
          aria-label={`直近60分の発言 ${a.total}件`}
        >
          {[0, 1, 2, 3, 4].map((i) => (
            <g key={i}>
              <line
                x1="30"
                y1={135 - i * 28}
                x2="510"
                y2={135 - i * 28}
                stroke="#e9edf2"
              />
              <text
                x="22"
                y={139 - i * 28}
                textAnchor="end"
                fill="#718096"
                fontSize="11"
              >
                {Math.round((max * i) / 4)}
              </text>
            </g>
          ))}
          {a.buckets.map((b, i) => (
            <rect
              key={b.at}
              x={38 + i * 39}
              y={135 - (b.count / max) * 112}
              width="25"
              height={Math.max(0, (b.count / max) * 112)}
              fill="#4397f7"
              rx="1"
            >
              <title>
                {time(b.at)}: {b.count}件
              </title>
            </rect>
          ))}
          <text x="30" y="156" fontSize="11" fill="#718096">
            {time(a.from).slice(0, 5)}
          </text>
          <text x="245" y="156" fontSize="11" fill="#718096">
            {time((a.from + a.to) / 2).slice(0, 5)}
          </text>
          <text x="505" y="156" fontSize="11" fill="#718096" textAnchor="end">
            {time(a.to).slice(0, 5)}
          </text>
        </svg>
        <Group justify="space-between">
          <Text size="sm">
            合計 <b>{a.total}件</b>
          </Text>
          <Text size="xs" c="dimmed">
            保存データの範囲 {time(a.observedFrom).slice(0, 5)}–
            {time(a.to).slice(0, 5)}
          </Text>
        </Group>
      </div>
    </TablePanel>
  );
}
export function App() {
  const [page, setPage] = useState("overview"),
    [projectId, setProjectId] = useState(""),
    [query, setQuery] = useState(""),
    [taskFilter, setTaskFilter] = useState("active"),
    [selection, select] = useState<Selection>(),
    [mobile, setMobile] = useState(false),
    [raw, setRaw] = useState({ target: "", events: false, key: 0 });
  const { state, error, stale, loading, refresh, now } =
    useRemoteState(projectId);
  if (!state)
    return (
      <main className="dashboard-entry">
        <Title order={1}>IDO Dashboard</Title>
        {loading ? (
          <Group mt="lg">
            <Loader size="sm" />
            <Text>管理状態を読み込んでいます</Text>
          </Group>
        ) : (
          <Alert
            mt="lg"
            color={error === "PERMISSION_DENIED" ? "yellow" : "red"}
          >
            {error === "PERMISSION_DENIED"
              ? "このダッシュボードは管理者専用です。"
              : error === "LOGIN_REQUIRED"
                ? "管理者アカウントでログインしてください。"
                : "エンジンへ接続できません。"}
            <Group mt="md">
              <Anchor href="/admin">Engine管理画面でログイン</Anchor>
              <Button variant="subtle" onClick={() => void refresh()}>
                再接続
              </Button>
            </Group>
          </Alert>
        )}
      </main>
    );
  const move = (id: string) => {
    setPage(id);
    setQuery("");
    select(undefined);
    setMobile(false);
  };
  const matching = state.tasks.filter((t) =>
    `${t.title} ${t.id}`.toLowerCase().includes(query.toLowerCase()),
  );
  const tasks = matching
    .filter(
      (t) =>
        taskFilter === "all" ||
        (taskFilter === "active" && isActive(t)) ||
        (taskFilter === "attention" && attention(t)) ||
        taskFilter === t.state,
    )
    .sort((a, b) => b.createdAt - a.createdAt);
  const current = state.tasks
    .filter(isActive)
    .sort(
      (a, b) =>
        Number(attention(b)) - Number(attention(a)) ||
        b.createdAt - a.createdAt,
    );
  const needs = state.tasks.filter(
    (t) => attention(t) && (isActive(t) || t.state === "failed"),
  );
  const counts = state.counts;
  const openRaw = (id: string) => {
    const events = state.tasks.some((t) => t.id === id);
    move("raw");
    setRaw((v) => ({ target: id, events, key: v.key + 1 }));
  };
  return (
    <AppShell
      navbar={{ width: 214, breakpoint: "sm", collapsed: { mobile: !mobile } }}
      padding={0}
      className="ido-dashboard"
    >
      <AppShell.Navbar className="dashboard-sidebar">
        <div className="brand">
          <Text fw={750} size="xl">
            IDO Dashboard
          </Text>
          <Text size="xs" c="dimmed">
            ENGINE ADMIN
          </Text>
        </div>
        <Stack gap={6} px="xs">
          {pages.map(([id, label]) => (
            <NavLink
              component="button"
              key={id}
              label={label}
              leftSection={<NavIcon kind={id} />}
              active={page === id}
              onClick={() => move(id)}
            />
          ))}
        </Stack>
        <div className="sidebar-account">
          <Anchor href="/admin" size="sm">
            接続・エンジン設定 ↗
          </Anchor>
          <Group mt="md" gap="xs">
            <NavIcon kind="users" />
            <Text size="sm">{state.user.name}</Text>
            <Badge variant="light" color="gray" size="xs">
              管理者
            </Badge>
          </Group>
        </div>
      </AppShell.Navbar>
      <AppShell.Main>
        <div className="dashboard-content">
          <Group justify="space-between" mb="md">
            <Group>
              <Burger
                hiddenFrom="sm"
                opened={mobile}
                onClick={() => setMobile((v) => !v)}
                aria-label="ナビゲーション"
                size="sm"
              />
              <div>
                <Title order={1}>
                  {pages.find(([id]) => id === page)?.[1]}
                </Title>
                <Text size="sm" c="dimmed">
                  {page === "overview"
                    ? "タスク・割当・参加状況を確認"
                    : page === "users"
                      ? "所属と現在の接続状態を確認"
                      : "エンジン全体の状態を確認"}
                </Text>
              </div>
            </Group>
            <Badge variant="light" color="gray">
              管理ダッシュボード
            </Badge>
          </Group>
          <Paper withBorder radius="sm" className="dashboard-toolbar">
            <Group justify="space-between">
              <Group gap="md">
                <Text
                  size="sm"
                  fw={600}
                  c={stale ? "orange" : "green"}
                  role="status"
                >
                  ● {stale ? "通信断・古い情報" : "エンジン接続中"}
                </Text>
                <Text size="xs" c="dimmed">
                  最終更新 {time(state.updatedAt)}
                </Text>
              </Group>
              <Group gap="sm">
                <Select
                  aria-label="プロジェクトで絞り込む"
                  value={projectId}
                  onChange={(v) => {
                    setProjectId(v ?? "");
                    select(undefined);
                  }}
                  data={[
                    { value: "", label: "全プロジェクト" },
                    ...state.projects.map((p) => ({
                      value: p.id,
                      label: p.name,
                    })),
                  ]}
                  allowDeselect={false}
                  size="xs"
                />
                <ActionIcon
                  variant="default"
                  aria-label="更新"
                  loading={loading}
                  onClick={() => void refresh()}
                >
                  <NavIcon kind="refresh" />
                </ActionIcon>
              </Group>
            </Group>
          </Paper>
          {stale && (
            <Alert color="yellow" mt="sm">
              最後に受信した状態を表示しています。再接続できるまで管理操作は無効です。
            </Alert>
          )}
          {page === "overview" && (
            <>
              <Text size="sm" fw={600} mt="md" mb="xs">
                現在の状態
              </Text>
              <SimpleGrid cols={{ base: 2, md: 5 }} spacing="sm">
                {[
                  ["実行中タスク", counts.running, "現在"],
                  ["待機タスク", counts.waiting, "未割当・割当済み"],
                  [
                    "接続中ユーザ",
                    counts.connectedUsers,
                    `登録 ${state.users.length}人`,
                  ],
                  [
                    "稼働中の会話",
                    counts.activeConversations,
                    "直近5分に人の発言",
                  ],
                  ["プロジェクト", counts.projects, "対象プロジェクト"],
                ].map(([label, value, detail]) => (
                  <Paper
                    withBorder
                    className="metric"
                    key={String(label)}
                    radius="sm"
                  >
                    <Text size="sm" c="dimmed">
                      {label}
                    </Text>
                    <Text className="metric-value">{value}</Text>
                    <Text size="xs" c="dimmed">
                      {detail}
                    </Text>
                  </Paper>
                ))}
              </SimpleGrid>
              {!!needs.length && (
                <Alert color="yellow" className="attention-banner">
                  <Group justify="space-between">
                    <Text size="sm">
                      <b>要対応 {needs.length}件</b>
                      <span style={{ marginLeft: 12 }}>
                        未割当・待機・停止確認・失敗
                      </span>
                    </Text>
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => {
                        move("tasks");
                        setTaskFilter("attention");
                      }}
                    >
                      対象を表示 →
                    </Button>
                  </Group>
                </Alert>
              )}
              <TablePanel
                title="タスクのルーティング"
                detail={
                  <Button
                    variant="subtle"
                    size="xs"
                    onClick={() => {
                      move("tasks");
                      setTaskFilter("active");
                    }}
                  >
                    進行中 {current.length}件・すべて表示 →
                  </Button>
                }
              >
                <TasksTable
                  state={state}
                  tasks={current}
                  now={now}
                  select={select}
                  compact
                />
              </TablePanel>
              <div className="overview-bottom">
                <TablePanel
                  title="プロジェクトと参加者"
                  detail={
                    <Button
                      size="xs"
                      variant="subtle"
                      onClick={() => move("projects")}
                    >
                      すべて表示
                    </Button>
                  }
                >
                  <ProjectsTable
                    state={state}
                    projectId={projectId}
                    select={select}
                  />
                </TablePanel>
                <Activity state={state} />
              </div>
            </>
          )}
          {page === "tasks" && (
            <>
              <Group my="md">
                <TextInput
                  aria-label="タスクを検索"
                  placeholder="タスク名・IDで検索"
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                />
                <Select
                  aria-label="タスクの状態"
                  value={taskFilter}
                  onChange={(v) => setTaskFilter(v || "all")}
                  allowDeselect={false}
                  data={[
                    { value: "all", label: "すべての状態" },
                    { value: "active", label: "進行中" },
                    { value: "attention", label: "要対応" },
                    { value: "running", label: "実行中" },
                    { value: "queued", label: "未割当" },
                    { value: "completed", label: "完了" },
                    { value: "failed", label: "失敗" },
                    { value: "cancelled", label: "停止" },
                  ]}
                />
              </Group>
              <TablePanel
                title="タスク一覧"
                detail={<Text size="sm">{tasks.length}件</Text>}
              >
                <TasksTable
                  state={state}
                  tasks={tasks}
                  now={now}
                  select={select}
                />
              </TablePanel>
            </>
          )}
          {page === "users" && (
            <>
              <Group my="md" justify="space-between">
                <Text size="sm">
                  接続中 {counts.connectedUsers}人 / 登録ユーザ
                </Text>
                <TextInput
                  aria-label="ユーザを検索"
                  placeholder="ユーザ名・IDで検索"
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                />
              </Group>
              <TablePanel title="ユーザと実行先">
                <UsersTable
                  state={state}
                  query={query}
                  select={select}
                  projectId={projectId}
                />
              </TablePanel>
              <Text size="xs" c="dimmed" mt="sm">
                同じ登録ユーザの複数端末は1人として集計します。会話のみの参加者は含みません。
              </Text>
            </>
          )}
          {page === "projects" && (
            <div className="page-section">
              <TablePanel title="プロジェクト一覧">
                <ProjectsTable
                  state={state}
                  projectId={projectId}
                  select={select}
                />
              </TablePanel>
              <Text size="xs" c="dimmed" mt="sm">
                所属は登録された端末のプロジェクト参加を基準に、ユーザ単位で集計します。
              </Text>
            </div>
          )}
          {page === "raw" && (
            <div className="page-section">
              <RawData
                key={`${raw.key}:${projectId}`}
                projectId={projectId}
                targetId={raw.target}
                eventTarget={raw.events}
              />
            </div>
          )}
        </div>
      </AppShell.Main>
      <Details
        state={state}
        selection={selection}
        close={() => select(undefined)}
        select={select}
        stale={stale}
        refresh={refresh}
        openRaw={openRaw}
      />
    </AppShell>
  );
}
