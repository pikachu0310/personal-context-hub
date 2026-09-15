import { MAX_EXECUTION_SLOTS } from "@ido/common/contracts/work";
import {
  ActionIcon,
  Button,
  Group,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core";
import { useState, type ReactNode } from "react";
import { Form, type Action } from "@ido/common-ui";
import { desktopBridge } from "./desktop.js";

export const projectHelp = {
  directory:
    "コミット済みGitリポジトリ、または空フォルダを選択してください。空フォルダはGitで初期化します。保存先・通信設定の変更前に実行を停止してください。",
  allow:
    "このPCで新しいタスクの実行を許可します。設定はClientの再起動後も保持します。実行には接続とエージェントの連携が必要です。Offにしても実行中のタスクは停止しません。",
  mode: "新しいタスクに適用します。Autoは依頼に沿って進めます。Manualはまず相談・計画し、「実行する」を押すと作業を開始します。受け取り済みのタスクは変更しません。",
  workspace:
    "別フォルダーではタスクごとにGit worktreeを作ります。直接編集では保存先をそのまま使うため、同じ場所を開いたUnityにも反映できます。直接編集の同時実行は1件です。変更前に実行許可をOffにしてください。",
  network:
    "サンドボックス内で実行するタスクの通信設定です。「許可を求める」「フルアクセス」では、この設定に関わらず通信可能です。受信タスクの明示的な通信禁止は優先します。",
};
export function ProjectField({
  label,
  help,
  children,
}: {
  label: string;
  help: string;
  children: ReactNode;
}) {
  return (
    <div className="project-form-row">
      <Group gap={6} wrap="nowrap">
        <Text size="sm" fw={500}>
          {label}
        </Text>
        <Tooltip
          label={help}
          multiline
          w={280}
          withArrow
          events={{ hover: true, focus: true, touch: true }}
        >
          <ActionIcon
            type="button"
            variant="subtle"
            color="gray"
            size="xs"
            className="project-help"
            aria-label={`${label}のヘルプ`}
          >
            ?
          </ActionIcon>
        </Tooltip>
      </Group>
      <div className="project-form-control">{children}</div>
    </div>
  );
}
export function ProjectToggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <Group gap="sm">
      <Switch
        size="sm"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <Text size="sm" c={!checked ? undefined : "dimmed"}>
        Off
      </Text>
      <Text size="sm" c={checked ? undefined : "dimmed"}>
        On
      </Text>
    </Group>
  );
}
export function ProjectMode({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <SegmentedControl
      size="sm"
      fullWidth
      aria-label="タスクの進め方"
      value={value}
      disabled={disabled}
      data={[
        { label: "Auto", value: "auto" },
        { label: "Manual", value: "manual" },
      ]}
      onChange={onChange}
    />
  );
}
export function ProjectWorkspaceMode({
  value,
  disabled,
  onChange,
}: {
  value: string;
  disabled?: boolean;
  onChange: (value: "worktree" | "project") => void;
}) {
  return (
    <SegmentedControl
      size="sm"
      fullWidth
      aria-label="作業場所"
      value={value}
      disabled={disabled}
      data={[
        { label: "別フォルダー", value: "worktree" },
        { label: "保存先を直接編集", value: "project" },
      ]}
      onChange={(mode) => onChange(mode as "worktree" | "project")}
    />
  );
}
export function ProjectDirectory({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const [error, setError] = useState("");
  const pick = desktopBridge()?.pickDirectory;
  return (
    <Stack gap={4}>
      <Group gap="xs" wrap="nowrap">
        <TextInput
          aria-label="保存先"
          required
          value={value}
          onChange={(e) => onChange(e.currentTarget.value)}
          style={{ flex: 1 }}
        />
        {pick && (
          <Button
            variant="default"
            onClick={async () => {
              try {
                const directory = await pick();
                if (directory) onChange(directory);
                setError("");
              } catch {
                setError("フォルダーを選択できません。");
              }
            }}
          >
            選択
          </Button>
        )}
      </Group>
      {error && (
        <Text size="sm" c="red" role="alert">
          {error}
        </Text>
      )}
    </Stack>
  );
}
export function AddProjectForm({
  projectId,
  action,
  saved,
}: {
  projectId?: string;
  action: Action;
  saved: () => void;
}) {
  const [name, setName] = useState(""),
    [directory, setDirectory] = useState(""),
    [allow, setAllow] = useState(true),
    [network, setNetwork] = useState(true),
    [mode, setMode] = useState("auto"),
    [workspaceMode, setWorkspaceMode] = useState<"worktree" | "project">(
      "worktree",
    );
  return (
    <div className="project-add-form">
      <Form
        fields={[]}
        label={projectId ? "保存先を設定" : "追加"}
        submit={async () => {
          await action(projectId ? "mappings" : "projects", {
            name,
            directory,
            ...(projectId ? { projectId } : {}),
            allow,
            network,
            progressMode: mode,
            workspaceMode,
            slots: workspaceMode === "project" ? 1 : MAX_EXECUTION_SLOTS,
          });
          saved();
        }}
      >
        <div
          className="project-form-group"
          role="group"
          aria-label="プロジェクト情報"
        >
          {!projectId && (
            <ProjectField label="名前" help="プロジェクトの表示名です。">
              <TextInput
                aria-label="名前"
                required
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
              />
            </ProjectField>
          )}
          <ProjectField label="保存先" help={projectHelp.directory}>
            <ProjectDirectory value={directory} onChange={setDirectory} />
          </ProjectField>
        </div>
        <div
          className="project-form-group"
          role="group"
          aria-label="タスク実行と通信"
        >
          <ProjectField label="作業場所" help={projectHelp.workspace}>
            <ProjectWorkspaceMode
              value={workspaceMode}
              onChange={setWorkspaceMode}
            />
            {workspaceMode === "project" && (
              <Text size="sm" c="dimmed">
                保存先を直接変更します。Unityを動かすPCのClientで設定してください。
              </Text>
            )}
          </ProjectField>
          <ProjectField label="タスクの実行許可" help={projectHelp.allow}>
            <ProjectToggle
              label="タスクの実行許可"
              checked={allow}
              onChange={setAllow}
            />
          </ProjectField>
          <ProjectField label="タスクの進め方" help={projectHelp.mode}>
            <ProjectMode value={mode} onChange={setMode} />
          </ProjectField>
          <ProjectField label="インターネット通信" help={projectHelp.network}>
            <ProjectToggle
              label="インターネット通信"
              checked={network}
              onChange={setNetwork}
            />
          </ProjectField>
        </div>
      </Form>
    </div>
  );
}
