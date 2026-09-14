import {
  Button,
  Group,
  NumberInput,
  SegmentedControl,
  Text,
} from "@mantine/core";
import { useState } from "react";
import { type Action, type ClientState } from "@ido/common-ui";
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
    <div className="project-settings-form">
      <ProjectField label="保存先" help={projectHelp.directory}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void update("mappings", {
              directory,
              network: mapping?.network ?? false,
              slots: mapping?.slots ?? 1,
            });
          }}
        >
          <Group gap="md" wrap="nowrap">
            <div style={{ flex: 1, minWidth: 0 }}>
              <ProjectDirectory value={directory} onChange={setDirectory} />
            </div>
            <Button type="submit" variant="default" loading={busy}>
              保存
            </Button>
          </Group>
        </form>
      </ProjectField>
      <ProjectField label="インターネット通信" help={projectHelp.network}>
        <ProjectToggle
          label="インターネット通信"
          checked={mapping?.network ?? false}
          disabled={!mapping || busy}
          onChange={(network) =>
            void update("mappings", {
              directory: mapping!.directory,
              network,
              slots: mapping!.slots,
            })
          }
        />
      </ProjectField>
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
      <details className="project-advanced">
        <summary>詳細設定</summary>
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
                void update("progress-mode", {
                  mode: "auto",
                  accessMode: "full",
                })
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
      </details>
      {error && (
        <Text size="sm" c="red" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}
