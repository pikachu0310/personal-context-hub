import {
  Alert,
  Anchor,
  AppShell,
  Button,
  Group,
  NavLink,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import type { ReactNode } from "react";
export function Shell({
  title,
  pages,
  page,
  select,
  refresh,
  error,
  children,
}: {
  title: string;
  pages: string[][];
  page: string;
  select: (page: string) => void;
  refresh: () => void;
  error?: string;
  children: ReactNode;
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
          {title !== "CLIENT" && (
            <Group>
              <Anchor href="/admin">管理</Anchor>
              <Anchor href="/dashboard/">Dashboard</Anchor>
            </Group>
          )}
        </Group>
      </AppShell.Header>
      <AppShell.Navbar p="md">
        <Stack>
          {pages.map(([id, label]) => (
            <NavLink
              key={id}
              label={label}
              active={page === id}
              onClick={() => select(id)}
            />
          ))}
        </Stack>
      </AppShell.Navbar>
      <AppShell.Main>
        <div className="content">
          <Group justify="space-between" mb="xl">
            <Title>{pages.find(([id]) => id === page)?.[1]}</Title>
            <Button variant="default" onClick={refresh}>
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
