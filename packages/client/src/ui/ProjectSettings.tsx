import {
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Stack,
  Text,
} from "@mantine/core";
import { useState } from "react";
import { Form, type Action, type ClientState } from "@ido/common-ui";
import {
  ProjectDirectory,
  ProjectField,
  ProjectMode,
  ProjectToggle,
  projectHelp,
} from "./ProjectForm.js";
export function ProjectSettings({
  projectId,
  state,
  action,
}: {
  projectId: string;
  state: ClientState;
  action: Action;
}) {
  const mapping = state.settings.mappings.find(
    (m) => m.projectId === projectId,
  );
  const [directory, setDirectory] = useState(mapping?.directory ?? ""),
    [network, setNetwork] = useState(mapping?.network ?? false),
    [slots, setSlots] = useState<number | string>(mapping?.slots ?? 1),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const allowed = state.allowedProjectIds?.includes(projectId) ?? false;
  async function update(path: string, data: Record<string, unknown>) {
    setError("");
    setBusy(true);
    try {
      await action(path, { projectId, ...data });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Stack gap="md">
      <Form
        fields={[]}
        label="保存先と通信設定を保存"
        submit={() =>
          action("mappings", {
            projectId,
            directory,
            network,
            slots: mapping?.slots ?? 1,
          })
        }
      >
        <ProjectField label="保存先" help={projectHelp.directory}>
          <ProjectDirectory value={directory} onChange={setDirectory} />
        </ProjectField>
        <ProjectField label="インターネット通信" help={projectHelp.network}>
          <ProjectToggle
            label="インターネット通信"
            checked={network}
            onChange={setNetwork}
          />
        </ProjectField>
      </Form>
      <ProjectField
        label="同時実行枠"
        help="このプロジェクトで同時に実行するタスク数（1〜8）です。保存先を設定してから変更できます。"
      >
        <Group gap="xs" wrap="nowrap">
          <NumberInput
            aria-label="同時実行枠"
            min={1}
            max={8}
            value={slots}
            onChange={setSlots}
            style={{ flex: 1 }}
          />
          <Button
            variant="default"
            disabled={!mapping || busy}
            onClick={() =>
              void update("allow", { allow: allowed, slots: Number(slots) })
            }
          >
            保存
          </Button>
        </Group>
      </ProjectField>
      <ProjectField
        label="タスクの実行許可"
        help={`${projectHelp.allow} 保存先の設定と接続が必要です。`}
      >
        <ProjectToggle
          label="タスクの実行許可"
          disabled={!mapping || !state.connected || busy}
          checked={allowed}
          onChange={(allow) =>
            void update("allow", { allow, slots: Number(slots) })
          }
        />
      </ProjectField>
      <ProjectField
        label="タスクの進め方"
        help={`${projectHelp.mode} 保存先を設定してから変更できます。`}
      >
        <ProjectMode
          value={mapping?.progressMode ?? "auto"}
          disabled={!mapping || busy}
          onChange={(mode) =>
            void update("progress-mode", {
              mode,
              accessMode: mode === "auto" ? "full" : "approval",
            })
          }
        />
      </ProjectField>
      <ProjectField
        label="タスクの権限"
        help="新しいタスクに適用します。フルアクセスはOSサンドボックスと承認なしでPCのファイル操作・通信が可能です。Manualの「許可を求める」では承認要求を表示します。受信タスクの明示的な制限は優先します。"
      >
        {(mapping?.progressMode ?? "auto") === "manual" ? (
          <SegmentedControl
            size="sm"
            fullWidth
            aria-label="新しいタスクの権限"
            disabled={!mapping || busy}
            value={mapping?.accessMode ?? "approval"}
            data={[
              { label: "許可を求める", value: "approval" },
              { label: "フルアクセス", value: "full" },
            ]}
            onChange={(accessMode) =>
              void update("progress-mode", { mode: "manual", accessMode })
            }
          />
        ) : (
          <Button
            variant="default"
            disabled={!mapping || busy}
            onClick={() =>
              void update("progress-mode", { mode: "auto", accessMode: "full" })
            }
          >
            フルアクセスを適用
          </Button>
        )}
      </ProjectField>
      {!mapping?.accessMode && (
        <Text size="sm" c="dimmed">
          タスクの権限は未適用です。
        </Text>
      )}
      {error && (
        <Text size="sm" c="red" role="alert">
          {error}
        </Text>
      )}
    </Stack>
  );
}
