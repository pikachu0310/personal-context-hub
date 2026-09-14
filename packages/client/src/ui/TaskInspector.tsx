import { createPortal } from "react-dom";
import { SourcePicker, type SourceTarget } from "./SourcePicker.js";
import {
  Badge,
  Drawer,
  Group,
  Paper,
  Stack,
  Tabs,
  Text,
  UnstyledButton,
} from "@mantine/core";
import { useMediaQuery } from "@mantine/hooks";
import { useEffect, useState, type ReactNode } from "react";
import type { TaskContextSource } from "@ido/common/contracts/api";
import { Icon } from "./Icons.js";

export function EnvironmentRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="environment-row">
      <Text size="xs" c="dimmed">
        {label}
      </Text>
      <div>{children}</div>
    </div>
  );
}

export function TaskInspector({
  children,
  sources = [],
  sourceNote,
  tab,
  onTabChange,
  changes,
  reveal = 0,
  sourceId,
  onSourceChange,
  sourceTarget,
}: {
  children: ReactNode;
  sourceTarget?: SourceTarget;
  sources?: TaskContextSource[];
  sourceNote?: string;
  tab: string | null;
  onTabChange: (tab: string | null) => void;
  changes?: ReactNode;
  reveal?: number;
  sourceId?: string;
  onSourceChange?: (id: string) => void;
}) {
  const compact = useMediaQuery("(max-width: 1150px)");
  const [opened, setOpened] = useState(false);
  const [desktopOpened, setDesktopOpened] = useState(true);
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    if (desktopOpened || reducedMotion) setCollapsed(!desktopOpened);
  }, [desktopOpened, reducedMotion]);
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [attachments, setAttachments] = useState<TaskContextSource[]>([]);
  useEffect(() => {
    setHeader(document.getElementById("task-inspector-control"));
  }, []);
  useEffect(() => {
    setAttachments([]);
  }, [sourceTarget?.taskId, sourceTarget?.runId]);
  const allSources = [
    ...new Map(
      [...sources, ...attachments].map((item) => [item.id, item]),
    ).values(),
  ];
  useEffect(() => {
    if (reveal > 0) {
      setOpened(true);
      setDesktopOpened(true);
    }
  }, [reveal]);
  const [selected, setSelected] = useState<string>();
  const source =
    allSources.find(
      (item) => item.id === (onSourceChange ? sourceId : selected),
    ) ?? allSources[0];
  const sourceList = (
    <Stack gap="xs">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          ソース
        </Text>
        <Group gap="xs">
          <Badge variant="light" color="gray">
            {allSources.length}
          </Badge>
          {sourceTarget && (
            <SourcePicker
              key={`${sourceTarget.taskId}:${sourceTarget.runId ?? "shared"}`}
              target={sourceTarget}
              onSources={setAttachments}
            />
          )}
        </Group>
      </Group>
      {sourceNote && (
        <Text size="xs" c="dimmed">
          {sourceNote}
        </Text>
      )}
      {!!attachments.length && (
        <Text size="xs" c="dimmed">
          追加資料はタスクに保存されています。実行中に追加した資料は次回の実行で参照されます。
        </Text>
      )}
      {!allSources.length && (
        <Text size="sm" c="dimmed">
          表示できるソースはありません。
        </Text>
      )}
      {allSources.map((item) => (
        <UnstyledButton
          className="source-link"
          key={item.id}
          onClick={() => {
            setSelected(item.id);
            onSourceChange?.(item.id);
            onTabChange("sources");
          }}
          data-selected={
            (tab === "sources" && source?.id === item.id) || undefined
          }
        >
          <Icon name={item.kind === "profile" ? "person" : "file"} size={17} />
          <span>{item.title}</span>
        </UnstyledButton>
      ))}
    </Stack>
  );
  const content = (
    <Tabs
      value={tab}
      onChange={onTabChange}
      keepMounted={false}
      className="inspector-tabs"
    >
      <Tabs.List grow aria-label="タスクの詳細">
        <Tabs.Tab
          value="environment"
          leftSection={<Icon name="computer" size={15} />}
        >
          環境
        </Tabs.Tab>
        <Tabs.Tab value="sources" leftSection={<Icon name="file" size={15} />}>
          ソース
        </Tabs.Tab>
        {changes && (
          <Tabs.Tab
            value="changes"
            leftSection={<Icon name="changes" size={15} />}
          >
            変更
          </Tabs.Tab>
        )}
      </Tabs.List>
      <Tabs.Panel value="environment">
        <Stack gap="lg">
          {children}
          <div className="inspector-section">{sourceList}</div>
        </Stack>
      </Tabs.Panel>
      <Tabs.Panel value="sources">
        <Stack gap="lg">
          {sourceList}
          {source && (
            <article className="source-preview">
              <Text size="xs" c="dimmed">
                {source.kind === "minutes"
                  ? "議事録"
                  : source.kind === "profile"
                    ? "ユーザー情報"
                    : "共有コンテキスト"}
              </Text>
              <Text fw={600} mt="sm">
                {source.title}
              </Text>
              {source.detail && (
                <Text size="xs" c="dimmed" mt="xs">
                  {source.detail}
                </Text>
              )}
              <div className="source-text">{source.text}</div>
            </article>
          )}
        </Stack>
      </Tabs.Panel>
      {changes && <Tabs.Panel value="changes">{changes}</Tabs.Panel>}
    </Tabs>
  );
  return (
    <>
      {header &&
        createPortal(
          <button
            className="icon-button inspector-header-toggle"
            aria-label="タスクの詳細"
            title="右側パネルの表示を切り替える"
            aria-expanded={compact ? opened : desktopOpened}
            onClick={() =>
              compact ? setOpened(!opened) : setDesktopOpened(!desktopOpened)
            }
          >
            <Icon name="details" size={23} />
          </button>,
          header,
        )}
      {compact ? (
        <>
          <Drawer
            opened={opened}
            onClose={() => setOpened(false)}
            transitionProps={{ duration: reducedMotion ? 0 : 280 }}
            position="right"
            title="タスクの詳細"
            size="min(380px, 100vw)"
          >
            {content}
          </Drawer>
        </>
      ) : (
        <Paper
          component="aside"
          withBorder
          radius="lg"
          className="task-inspector"
          data-closed={!desktopOpened || undefined}
          data-collapsed={(!desktopOpened && collapsed) || undefined}
          aria-hidden={!desktopOpened || undefined}
          inert={!desktopOpened}
          onTransitionEnd={(event) => {
            if (
              event.target === event.currentTarget &&
              event.propertyName === "transform"
            )
              setCollapsed(!desktopOpened);
          }}
          aria-label="タスクの詳細"
        >
          {content}
        </Paper>
      )}
    </>
  );
}
