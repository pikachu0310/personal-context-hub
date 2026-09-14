import { Menu, Modal, Text } from "@mantine/core";
import { useState } from "react";
import { Form } from "@ido/common-ui";
import type { Project } from "@ido/common/contracts/protocol";
import type { Action } from "@ido/common-ui";
export function ProjectMenu({
  project,
  deviceId,
  action,
  mapping,
}: {
  project: Project;
  deviceId?: string;
  action: Action;
  mapping: () => void;
}) {
  const [rename, setRename] = useState(false),
    [url, setUrl] = useState(""),
    [error, setError] = useState("");
  const owner = project.ownerDeviceId === deviceId;
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
          <Menu.Item onClick={mapping}>接続・設定</Menu.Item>
          {owner && (
            <>
              <Menu.Item onClick={() => setRename(true)}>
                プロジェクト名を編集
              </Menu.Item>
              <Menu.Item
                onClick={async () => {
                  try {
                    const result = await action("project/invite", {
                      projectId: project.id,
                    });
                    setUrl(result.url!);
                    await navigator.clipboard.writeText(result.url!);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                招待URLをコピー
              </Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>
      <Modal
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
        opened={!!url || !!error}
        onClose={() => {
          setUrl("");
          setError("");
        }}
        title={error ? "操作できませんでした" : "招待URLをコピーしました"}
      >
        <Text>
          {error ||
            "招待リンクは7日間有効です。参加者は承認済みClientで開き、保存先を選択します。"}
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
