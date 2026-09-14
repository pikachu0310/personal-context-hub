import { Button, FileInput, Group, Text } from "@mantine/core";
import { useState } from "react";
import { Form, type Action, type ClientState } from "@ido/common-ui";
import { UserAvatar } from "./TaskAvatars.js";

async function readAvatar(file: File) {
  if (
    !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
    file.size > 5 * 1024 * 1024
  )
    throw new Error("PNG・JPEG・WebPの5MB以下の画像を選択してください。");
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const side = Math.min(bitmap.width, bitmap.height);
    ctx.fillStyle = "#e9edf5";
    ctx.fillRect(0, 0, 64, 64);
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      64,
      64,
    );
    for (const quality of [0.8, 0.65, 0.45, 0.25]) {
      const data = canvas.toDataURL("image/jpeg", quality);
      if (data.length <= 4096) return data;
    }
    throw new Error("画像を小さくしてから再度選択してください。");
  } finally {
    bitmap.close();
  }
}
export function ProfileSettings({
  state,
  action,
  saved,
}: {
  state: ClientState;
  action: Action;
  saved: () => void;
}) {
  const [avatar, setAvatar] = useState(state.settings.profile?.avatar ?? "");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  return (
    <>
      <Text mb="md">
        アイコン・表示名・個人コンテキストは、参加しているプロジェクトで共有されます。
      </Text>
      <Group mb="md" className="profile-avatar-editor">
        <UserAvatar
          person={{
            id: "self",
            name: state.settings.profile?.name || "自分",
            avatar,
          }}
        />
        <FileInput
          label="ユーザーアイコン"
          placeholder="画像をアップロード"
          accept="image/png,image/jpeg,image/webp"
          disabled={loading}
          onChange={async (file) => {
            if (!file) return;
            setLoading(true);
            setError("");
            try {
              setAvatar(await readAvatar(file));
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setLoading(false);
            }
          }}
        />
        <Button
          variant="subtle"
          disabled={!avatar || loading}
          onClick={() => setAvatar("")}
        >
          アイコンを削除
        </Button>
      </Group>
      <Text size="xs" c="dimmed" mb="md">
        PNG・JPEG・WebP、5MBまで。中央を正方形に切り抜いて保存します。
      </Text>
      {error && (
        <Text c="red" role="alert">
          {error}
        </Text>
      )}
      <Form
        initial={{
          name: state.settings.profile?.name ?? "参加者",
          context: state.settings.profile?.context ?? "",
        }}
        fields={[
          { key: "name", label: "アカウント名" },
          {
            key: "context",
            label: "個人コンテキスト（自己紹介・開発担当など）",
            multiline: true,
            optional: true,
          },
        ]}
        submit={async (data) => {
          if (loading) throw new Error("画像の読み込みを待ってください。");
          await action("profile", { ...data, avatar });
          saved();
        }}
      />
    </>
  );
}
