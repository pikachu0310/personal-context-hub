import {
  Alert,
  ActionIcon,
  Anchor,
  AppShell,
  Button,
  Group,
  Menu,
  NavLink,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import type { ReactNode } from "react";
import { Icon } from "./Icon.js";
export function Shell({
  title,
  pages,
  page,
  select,
  refresh,
  error,
  children,
  workspaceLinks = title !== "CLIENT",
  account,
}: {
  title: string;
  pages: string[][];
  page: string;
  select: (page: string) => void;
  refresh: () => void;
  error?: string;
  children: ReactNode;
  workspaceLinks?: boolean;
  account?: { name: string; logout: () => void };
}) {
  return (
    <AppShell
      header={{ height: 72 }}
      navbar={{ width: 230, breakpoint: "sm" }}
      padding="xl"
    >
      <AppShell.Header>
        <Group h="100%" px="xl" justify="space-between">
          <Text className="wordmark">
            IDO <span>/ {title}</span>
          </Text>
          {workspaceLinks && (
            <Group>
              <Anchor href="/admin">管理</Anchor>
              <Anchor href="/dashboard/">Dashboard</Anchor>
            </Group>
          )}
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="md">
        <Stack className="shell-navigation" gap="xs">
          {pages.map(([id, label]) => (
            <NavLink
              key={id}
              label={label}
              active={page === id}
              onClick={() => select(id)}
            />
          ))}
        </Stack>
        {account && (
          <footer className="shell-account">
            <Menu position="top-start" withArrow>
              <Menu.Target>
                <ActionIcon
                  size="lg"
                  radius="xl"
                  variant="light"
                  aria-label="アカウントメニューを開く"
                >
                  <Icon name="user" />
                </ActionIcon>
              </Menu.Target>
              <Menu.Dropdown>
                <Menu.Label>{account.name}</Menu.Label>
                <Menu.Item
                  color="red"
                  leftSection={<Icon name="logout" />}
                  onClick={account.logout}
                >
                  ログアウト
                </Menu.Item>
              </Menu.Dropdown>
            </Menu>
            <Text size="sm" fw={500} truncate>
              {account.name}
            </Text>
          </footer>
        )}
      </AppShell.Navbar>
      <AppShell.Main>
        <div className="content">
          <Group justify="space-between" mb="xl">
            <Title>{pages.find(([id]) => id === page)?.[1]}</Title>
            <Button
              variant="default"
              leftSection={<Icon name="refresh" />}
              onClick={refresh}
            >
              更新
            </Button>
          </Group>
          {error && (
            <Alert color="red" mb="lg">
              {error}
            </Alert>
          )}
          {children}
        </div>
      </AppShell.Main>
    </AppShell>
  );
}
