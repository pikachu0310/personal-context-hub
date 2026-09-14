import {
  Alert,
  NumberInput,
  Button,
  Paper,
  SegmentedControl,
  Stack,
  Switch,
  Text,
  Title,
} from "@mantine/core";
import { useState } from "react";
import { Form, type Action, type ClientState } from "@ido/common-ui";
import { desktopBridge } from "./desktop.js";
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
  const [network, setNetwork] = useState(mapping?.network ?? false),
    [error, setError] = useState(""),
    [slots, setSlots] = useState<number | string>(mapping?.slots ?? 1);
  const allowed = state.allowedProjectIds?.includes(projectId) ?? false;
  return (
    <div className="project-document">
      <Stack>
        <Title order={2}>接続・設定</Title>
        <Text c="dimmed">このClientでのプロジェクト設定です。</Text>
        {!allowed && (
          <Alert color="yellow" title="このプロジェクトの実行許可はOFFです">
            タスクを始めるには、下の「このプロジェクトのタスクを受け取って実行する」をONにしてください。
            {(state.projectTasks ?? []).filter(
              (t) => t.projectId === projectId && t.state === "queued",
            ).length > 0 &&
              `このプロジェクトには${(state.projectTasks ?? []).filter((t) => t.projectId === projectId && t.state === "queued").length}件の待機タスクがあります。許可すると実行枠の範囲で順番に割り当てます。`}
          </Alert>
        )}
        <Paper p="lg" withBorder>
          <Title order={3} mb="md">
            保存先と接続
          </Title>
          <Text mb="md" size="sm">
            コミット済みGitリポジトリ、または空フォルダを選択してください。保存先の変更は、タスク実行を一時停止してから行います。
          </Text>
          <Form
            initial={{ directory: mapping?.directory ?? "" }}
            fields={[
              {
                key: "directory",
                label: "ディレクトリ",
                pick: desktopBridge()?.pickDirectory,
              },
            ]}
            submit={(data) =>
              action("mappings", {
                ...data,
                projectId,
                network,
                slots: mapping?.slots ?? 1,
              })
            }
            label="保存先と通信設定を保存"
          >
            <Switch
              label="このプロジェクトで通信を許可する"
              checked={network}
              onChange={(e) => setNetwork(e.currentTarget.checked)}
            />
          </Form>
        </Paper>
        <Paper p="lg" withBorder>
          <Title order={3} mb="md">
            タスクの実行許可
          </Title>
          <Text mb="md">
            この接続中、このプロジェクトのタスクを許可した保存先・通信権限の範囲で実行します。追加の権限要求はローカル画面で承認します。Clientを終了すると許可は解除されます。
          </Text>
          <NumberInput
            label="このプロジェクトの同時実行枠"
            min={1}
            max={8}
            value={slots}
            onChange={setSlots}
            w={220}
          />
          <Button
            mt="sm"
            variant="light"
            disabled={!mapping}
            onClick={() => {
              void action("allow", {
                projectId,
                allow: allowed,
                slots: Number(slots),
              }).catch((e) => setError(e.message));
            }}
          >
            実行枠を保存
          </Button>
          <Switch
            mt="md"
            label="このプロジェクトのタスクを受け取って実行する"
            disabled={!mapping || !state.connected}
            checked={allowed}
            onChange={(e) => {
              void action("allow", {
                projectId,
                allow: e.currentTarget.checked,
                slots: Number(slots),
              }).catch((e) => setError(e.message));
            }}
          />
          {state.loginStatus !== "authenticated" && (
            <Text mt="sm" c="dimmed">
              Codex未連携のため、現在タスクは割り当てられません。
            </Text>
          )}
        </Paper>
        <Paper p="lg" withBorder>
          <Title order={3} mb="md">
            新しいタスクの進め方
          </Title>
          <Text mb="md">
            このプロジェクトでこれから受け取るタスクに適用します。受け取り済みのタスクの進め方は維持します。
          </Text>
          <SegmentedControl
            aria-label="このプロジェクトの新しいタスクの進め方"
            disabled={!mapping}
            value={mapping?.progressMode ?? "auto"}
            data={[
              { label: "Auto", value: "auto" },
              { label: "Manual · 会話する", value: "manual" },
            ]}
            onChange={(mode) => {
              setError("");
              void action("progress-mode", { projectId, mode }).catch((e) =>
                setError(e.message),
              );
            }}
          />
          <Text mt="sm" size="sm" c="dimmed">
            Autoは依頼に沿って進めます。Manualはまず相談・計画し、「実行する」を押したら作業に入ります。
          </Text>
          {!mapping && <Text mt="sm">先に保存先を設定してください。</Text>}
          {error && (
            <Text c="red" role="alert">
              {error}
            </Text>
          )}
        </Paper>
      </Stack>
    </div>
  );
}
