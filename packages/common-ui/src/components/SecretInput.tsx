import { Badge, Button, Group, Stack, TextInput } from "@mantine/core";

export function SecretInput({
  label,
  configured,
  editing,
  value,
  busy,
  required,
  onChange,
  onToggleEdit,
}: {
  label: string;
  configured?: boolean;
  editing: boolean;
  value: string;
  busy?: boolean;
  required?: boolean;
  onChange: (value: string) => void;
  onToggleEdit: () => void;
}) {
  return (
    <Stack gap="xs">
      <TextInput
        label={label}
        type="text"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        value={configured && !editing ? "********" : value}
        readOnly={configured && !editing}
        placeholder="新しい値を入力"
        description={
          configured
            ? "保存済みの値を使用します。変更する場合だけ入力してください。"
            : "未設定です。保存すると入力欄から値を消去します。"
        }
        onChange={(e) => onChange(e.currentTarget.value)}
        required={required && (!configured || editing)}
      />
      <Group gap="xs">
        <Badge color={configured ? "teal" : "gray"} variant="light">
          {configured ? "設定済み" : "未設定"}
        </Badge>
        {configured && (
          <Button
            type="button"
            variant="subtle"
            size="xs"
            disabled={busy}
            aria-label={`${label}を${editing ? "変更せずに戻る" : "変更"}`}
            onClick={onToggleEdit}
          >
            {editing ? "変更せずに戻る" : "変更"}
          </Button>
        )}
      </Group>
    </Stack>
  );
}
