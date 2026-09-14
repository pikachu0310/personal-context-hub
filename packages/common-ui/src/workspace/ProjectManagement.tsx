import { Button, Group, Modal, Stack, Text, TextInput } from "@mantine/core";
import { useState } from "react";
import type { Project } from "@ido/common/contracts/protocol";
import type { Action } from "../types.js";
import { lifecycleError } from "../components/TaskMenu.js";
export function ProjectManagement({
  project,
  action,
  disabled = false,
}: {
  project: Pick<Project, "id" | "name" | "isDefault" | "membershipVersion">;
  action: Action;
  disabled?: boolean;
}) {
  const [confirm, setConfirm] = useState(false),
    [name, setName] = useState(""),
    [url, setUrl] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      await action("project/delete", {
        projectId: project.id,
        name,
        confirm: true,
        membershipVersion: version,
      });
      setConfirm(false);
    } catch (e) {
      setError(lifecycleError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Group mt="sm">
        <Button
          variant="default"
          disabled={disabled}
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
        </Button>
        <Button
          variant="subtle"
          color="red"
          disabled={disabled || project.isDefault || project.id === "default"}
          onClick={() => {
            setVersion(project.membershipVersion ?? 0);
            setConfirm(true);
            setName("");
            setError("");
          }}
        >
          プロジェクトを完全削除
        </Button>
      </Group>
      {project.isDefault && (
        <Text size="xs" c="dimmed">
          デフォルトプロジェクトは完全削除できません。
        </Text>
      )}
      <Modal
        centered
        opened={confirm || !!url || !!error}
        onClose={() => {
          if (!busy) {
            setConfirm(false);
            setUrl("");
            setError("");
          }
        }}
        title={confirm ? "プロジェクトを完全に削除" : "招待URL"}
        closeOnEscape={!busy}
        closeOnClickOutside={!busy}
      >
        <Stack>
          {confirm ? (
            <>
              <Text>
                「{project.name}
                」と、配下の全タスク・議事録・履歴・参加情報・招待・IDOのAIコンテキストを全ユーザーから削除します。元に戻せません。
              </Text>
              <Text size="sm">
                Gitフォルダと外部サービスの投稿は残ります。オフライン端末のローカル履歴は再接続後に整理されます。
              </Text>
              <TextInput
                label="確認のためプロジェクト名を入力"
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
              />
              <Group justify="flex-end">
                <Button
                  data-autofocus
                  variant="default"
                  disabled={busy}
                  onClick={() => {
                    setConfirm(false);
                    setError("");
                  }}
                >
                  キャンセル
                </Button>
                <Button
                  color="red"
                  disabled={disabled || name !== project.name}
                  loading={busy}
                  onClick={() => void remove()}
                >
                  完全に削除する
                </Button>
              </Group>
            </>
          ) : (
            <Text style={{ overflowWrap: "anywhere" }}>{url}</Text>
          )}
          {error && (
            <Text role="alert" c="red">
              {error}
            </Text>
          )}
        </Stack>
      </Modal>
    </>
  );
}
