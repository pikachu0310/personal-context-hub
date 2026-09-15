import { useEffect, useState } from "react";
import { Alert, Button, Modal, MultiSelect, Stack, Text } from "@mantine/core";
import type { ImplementationChoice } from "@ido/common/contracts/api";
import { api } from "./api.js";
import { openPreview } from "./preview-links.js";

export function ImplementationPicker({
  projectId,
  taskId,
}: {
  projectId: string;
  taskId: string;
}) {
  const [opened, setOpened] = useState(false);
  const [choices, setChoices] = useState<ImplementationChoice[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!opened) return;
    let active = true,
      initialized = false;
    const read = () =>
      api<ImplementationChoice[]>("implementations/list", { projectId })
        .then((result) => {
          if (!active) return;
          setChoices(result);
          if (!initialized) {
            initialized = true;
            const current = result.find(
              (v) => v.taskId === taskId,
            )?.implementation;
            setSelected(current ? [current.id] : []);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    setError("");
    setChoices([]);
    setSelected([]);
    void read();
    const timer = setInterval(() => void read(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [opened, projectId, taskId]);
  return (
    <>
      <Button size="xs" variant="light" onClick={() => setOpened(true)}>
        実装を起動・比較
      </Button>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title="実装を起動・比較"
      >
        <Stack>
          <Text size="sm">
            push済みの実装を1〜2件選び、このPCで起動します。
          </Text>
          <MultiSelect
            label="実装済みタスク"
            searchable
            maxValues={2}
            value={selected}
            onChange={setSelected}
            data={choices.map((choice) => ({
              value:
                choice.implementation?.id ?? `unavailable-${choice.taskId}`,
              label:
                choice.title +
                (!choice.implementation ? "（取得できる実装なし）" : ""),
              disabled: !choice.implementation,
            }))}
            nothingFoundMessage="取得できる実装がありません"
          />
          {error && <Alert color="red">{error}</Alert>}
          <Button
            disabled={!selected.length}
            onClick={() => {
              openPreview({ projectId, implementationIds: selected });
              setOpened(false);
            }}
          >
            ローカルへ取得
          </Button>
        </Stack>
      </Modal>
    </>
  );
}
