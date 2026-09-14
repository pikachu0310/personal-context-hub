import { Button, Group, Menu, Modal, Select, Stack, Text } from "@mantine/core";
import { useState } from "react";
import { Form, lifecycleError } from "@ido/common-ui";
import type { Project } from "@ido/common/contracts/protocol";
import type { ProjectWorkspace } from "@ido/common/contracts/api";
import type { Action } from "@ido/common-ui";
import { api } from "./api.js";
export function ProjectMenu({
  project,
  deviceId,
  action,
  mapping,
  startLocal,
}: {
  project: Project;
  deviceId?: string;
  action: Action;
  mapping: () => void;
  startLocal: () => void;
}) {
  const [rename, setRename] = useState(false),
    [url, setUrl] = useState(""),
    [error, setError] = useState("");
  const [mode, setMode] = useState<"leave" | "transfer">(),
    [snapshot, setSnapshot] = useState<ProjectWorkspace>(),
    [target, setTarget] = useState<string | null>(null),
    [busy, setBusy] = useState(false);
  const owner = project.ownerDeviceId === deviceId;
  const open = async (value: "leave" | "transfer") => {
    setMode(value);
    setSnapshot(undefined);
    setError("");
    setTarget(null);
    try {
      setSnapshot(
        await api<ProjectWorkspace>("project/snapshot", {
          projectId: project.id,
        }),
      );
    } catch (e) {
      setError(lifecycleError(e));
    }
  };
  const candidates =
    snapshot?.participants.filter((p) => p.id !== deviceId) ?? [];
  const active =
    snapshot?.tasks.filter(
      (t) =>
        t.clientId === deviceId &&
        (["running", "assigned", "interrupted"].includes(t.state) ||
          Object.values(t.controlReceipts ?? {}).some(
            (r) =>
              r.type === "stop" &&
              !["stopped", "rejected"].includes(r.delivery),
          )),
    ) ?? [];
  const currentOwner = snapshot?.project.ownerDeviceId === deviceId;
  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      await action(
        mode === "leave" ? "project/leave" : "project/transfer-owner",
        {
          projectId: project.id,
          deviceId: target,
          membershipVersion: snapshot?.project.membershipVersion ?? 0,
        },
      );
      setMode(undefined);
    } catch (e) {
      setError(lifecycleError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Menu position="bottom-end" withinPortal>
        <Menu.Target>
          <button
            className="icon-button project-menu"
            aria-label={`${project.name}の設定`}
          >
            ⋯
          </button>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Item onClick={startLocal}>このPCでタスクを開始</Menu.Item>
          <Menu.Item onClick={mapping}>接続・設定</Menu.Item>
          {owner && (
            <>
              <Menu.Item onClick={() => setRename(true)}>
                プロジェクト名を編集
              </Menu.Item>
              <Menu.Item onClick={() => void open("transfer")}>
                ownerを変更
              </Menu.Item>
            </>
          )}
          <Menu.Item
            onClick={async () => {
              try {
                const result = await action("project/invite", {
                  projectId: project.id,
                });
                setUrl(result.url!);
                await navigator.clipboard.writeText(result.url!);
              } catch (e) {
                setError(lifecycleError(e));
              }
            }}
          >
            招待URLをコピー
          </Menu.Item>
          <Menu.Item onClick={() => void open("leave")}>退出</Menu.Item>
        </Menu.Dropdown>
      </Menu>
      <Modal
        centered
        opened={rename}
        onClose={() => setRename(false)}
        title="プロジェクト名を編集"
      >
        <Form
          initial={{ name: project.name }}
          fields={[{ key: "name", label: "プロジェクト名" }]}
          submit={async (data) => {
            await action("project/rename", { projectId: project.id, ...data });
            setRename(false);
          }}
        />
      </Modal>
      <Modal
        centered
        opened={!!mode}
        onClose={() => {
          if (!busy) {
            setMode(undefined);
            setError("");
          }
        }}
        title={mode === "leave" ? "プロジェクトから退出" : "ownerを変更"}
        closeOnClickOutside={!busy}
        closeOnEscape={!busy}
      >
        <Stack>
          <Text fw={600}>{project.name}</Text>
          {!snapshot && !error && <Text>最新の参加者・タスクを確認中…</Text>}
          {mode === "leave" ? (
            <>
              <Text>
                プロジェクトと配下のタスク・議事録が一覧から消え、全タスクの参加からも退出します。共有データとローカルGitフォルダは残ります。
              </Text>
              <Text size="sm" c="dimmed">
                有効な招待URLから再参加できます。タスクへの参加と実行許可は自動で復元されません。
              </Text>
              {currentOwner && (
                <Text c="orange">
                  先に「ownerを変更」から既存の参加者へ権限を移譲してください。候補がいない場合は、参加者を招待してください。
                </Text>
              )}
              {active.length > 0 && (
                <>
                  <Text c="orange">
                    このPCの次のタスクを停止・完了してから退出してください。
                  </Text>
                  {active.map((t) => (
                    <Text key={t.id}>{t.title ?? t.text}</Text>
                  ))}
                </>
              )}
            </>
          ) : (
            <>
              <Text>
                選んだ参加者へowner権限を渡します。移譲後は自分でownerを変更できなくなります。
              </Text>
              {snapshot && !candidates.length ? (
                <Text>
                  移譲先がいません。先に「招待URLをコピー」で参加者を招待してください。
                </Text>
              ) : (
                <Select
                  label="新しいowner"
                  data={candidates.map((p) => ({ value: p.id, label: p.name }))}
                  value={target}
                  onChange={setTarget}
                />
              )}
            </>
          )}
          {error && (
            <Text c="red" role="alert">
              {error}
            </Text>
          )}
          <Group justify="flex-end">
            <Button
              data-autofocus
              variant="default"
              disabled={busy}
              onClick={() => {
                setMode(undefined);
                setError("");
              }}
            >
              キャンセル
            </Button>
            <Button
              loading={busy}
              disabled={
                !snapshot ||
                (mode === "leave" ? currentOwner || active.length > 0 : !target)
              }
              onClick={() => void apply()}
            >
              {mode === "leave" ? "退出する" : "権限を移譲する"}
            </Button>
          </Group>
        </Stack>
      </Modal>
      <Modal
        centered
        opened={!mode && (!!url || !!error)}
        onClose={() => {
          setUrl("");
          setError("");
        }}
        title={error ? "操作できませんでした" : "招待URLをコピーしました"}
      >
        <Text>
          {error ||
            "招待リンクは7日間有効です。承認済みClientで開いて参加します。"}
        </Text>
        {url && (
          <Text mt="md" style={{ overflowWrap: "anywhere" }}>
            {url}
          </Text>
        )}
      </Modal>
    </>
  );
}
