import { Paper, Stack, Text, Title } from "@mantine/core";
import React from "react";
export function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <Paper p="lg" withBorder radius="lg">
      <Stack gap="md">
        <div>
          <Title order={3} size="h4">
            {title}
          </Title>
          {description && (
            <Text c="dimmed" size="sm" mt={5}>
              {description}
            </Text>
          )}
        </div>
        {children}
      </Stack>
    </Paper>
  );
}
