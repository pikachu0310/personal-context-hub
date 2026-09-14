import { Alert, Modal, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { Form } from "@ido/common-ui";
import type { Project } from "@ido/common/contracts/protocol";
import { api } from "./api.js";
import { desktopBridge } from "./desktop.js";
export function InviteDialog({
  invite,
  connected,
  onClose,
}: {
  invite?: { engineUrl: string; token: string };
  connected: boolean;
  onClose: () => void;
}) {
  const [project, setProject] = useState<Project>(),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setProject(undefined);
    setError("");
    if (invite && connected)
      void api<Project>("project/inspect-invite", invite)
        .then((p) => {
          if (active) setProject(p);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    return () => {
      active = false;
    };
  }, [invite?.token, connected]);
  return (
    <Modal
      opened={!!invite && connected}
      onClose={onClose}
      title={`${project?.name ?? "プロジェクト"} に参加`}
    >
      <Text mb="md">
        このPCの保存先を選択してください。参加によってタスク実行や通信が許可されることはありません。
      </Text>
      {error ? (
        <Alert color="red">{error}</Alert>
      ) : project ? (
        <Form
          fields={[
            {
              key: "directory",
              label: "ディレクトリ",
              pick: desktopBridge()?.pickDirectory,
            },
          ]}
          submit={async (data) => {
            await api("project/join", { ...invite, ...data });
            onClose();
          }}
          label="参加して保存先を設定"
        />
      ) : (
        <Text>招待を確認しています…</Text>
      )}
    </Modal>
  );
}
