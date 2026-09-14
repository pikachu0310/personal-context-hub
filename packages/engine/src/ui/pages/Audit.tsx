import { Table, Text } from "@mantine/core";
import type { AdminState } from "@ido/common-ui";

export function Audit({ state }: { state: AdminState }) {
  return (
    <section aria-label="操作履歴">
      <Text size="sm" c="dimmed" mb="xs">
        {state.audit.length}件の操作
      </Text>
      <div className="admin-table-scroll">
        <Table
          className="admin-table"
          horizontalSpacing="sm"
          verticalSpacing={6}
          highlightOnHover
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th>日時</Table.Th>
              <Table.Th>操作</Table.Th>
              <Table.Th>対象</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {state.audit.map((event, index) => (
              <Table.Tr key={index}>
                <Table.Td className="admin-timestamp">
                  {new Date(event.at).toLocaleString()}
                </Table.Td>
                <Table.Td>
                  <code>{event.action}</code>
                </Table.Td>
                <Table.Td className="admin-target">
                  <code>{event.target || "—"}</code>
                </Table.Td>
              </Table.Tr>
            ))}
            {!state.audit.length && (
              <Table.Tr>
                <Table.Td colSpan={3}>
                  <Text size="sm" c="dimmed">
                    操作履歴はありません。
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
          </Table.Tbody>
        </Table>
      </div>
    </section>
  );
}
