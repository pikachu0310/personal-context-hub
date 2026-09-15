import { Button, Group, NumberInput, Select, Text } from "@mantine/core";
import { useState } from "react";
import { type Action, type ClientState } from "@ido/common-ui";
import { accessOptions, accessHelp, projectAccessHelp } from "./access-mode.js";
import {
  ProjectDirectory,
  ProjectField,
  ProjectMode,
  ProjectWorkspaceMode,
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
      <div
        className="project-form-group"
        role="group"
        aria-label="保存先と通信"
      >
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
            <Group gap="xs" wrap="nowrap">
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
      </div>
      <div className="project-form-group" role="group" aria-label="タスク実行">
        <ProjectField label="作業場所" help={projectHelp.workspace}>
          <ProjectWorkspaceMode
            value={mapping?.workspaceMode ?? "worktree"}
            disabled={!mapping || busy || allowed}
            onChange={(workspaceMode) =>
              void update("mappings", {
                directory: mapping!.directory,
                network: mapping!.network,
                slots: mapping!.slots,
                workspaceMode,
              })
            }
          />
          <Text size="sm" c="dimmed" mt="xs">
            {allowed
              ? "変更するにはタスクの実行許可をOffにしてください。"
              : mapping?.workspaceMode === "project"
                ? "保存先を直接変更します。Unityを開いているPCのClientで設定してください。"
                : "タスクごとに別の作業フォルダーを作ります。"}
          </Text>
        </ProjectField>
        <ProjectField
          label="同時実行枠"
          help="このプロジェクトで同時に実行するタスク数（1〜8）です。保存先を設定してから変更できます。"
        >
          <Group gap="xs" wrap="nowrap">
            <NumberInput
              aria-label="同時実行枠"
              min={1}
              max={mapping?.workspaceMode === "project" ? 1 : 8}
              disabled={mapping?.workspaceMode === "project"}
              value={mapping?.workspaceMode === "project" ? 1 : slots}
              onChange={setSlots}
              style={{ flex: 1 }}
            />
            <Button
              variant="default"
              disabled={!mapping || busy}
              onClick={() => void update("allow", { slots: Number(slots) })}
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
              })
            }
          />
        </ProjectField>
      </div>
      <details className="project-advanced">
        <summary>詳細設定</summary>
        <ProjectField label="タスクの権限" help={projectAccessHelp}>
          <Select
            size="sm"
            aria-label="新しいタスクの権限"
            disabled={!mapping || busy}
            value={mapping?.accessMode ?? "sandbox"}
            data={accessOptions}
            allowDeselect={false}
            onChange={(accessMode) => {
              if (accessMode) void update("access-mode", { accessMode });
            }}
          />
          <Text size="sm" c="dimmed" mt="xs">
            {accessHelp[mapping?.accessMode ?? "sandbox"]}
          </Text>
        </ProjectField>
      </details>
      {error && (
        <Text size="sm" c="red" role="alert">
          {error}
        </Text>
      )}
    </div>
  );
}
