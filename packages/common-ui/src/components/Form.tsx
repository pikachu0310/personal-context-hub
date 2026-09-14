import {
  Alert,
  Button,
  PasswordInput,
  Select,
  Stack,
  Textarea,
  TextInput,
  Group,
  Badge,
} from "@mantine/core";
import React, { useState } from "react";
export type Field = {
  key: string;
  label: string;
  secret?: boolean;
  password?: "current-password" | "new-password";
  configured?: boolean;
  options?: Array<{ value: string; label: string }>;
  multiline?: boolean;
  placeholder?: string;
  optional?: boolean;
  pick?: () => Promise<string | undefined>;
};
export function Form({
  fields,
  initial = {},
  submit,
  label = "保存",
  children,
}: {
  fields: Field[];
  initial?: Record<string, string | null>;
  submit: (data: Record<string, string | null>) => Promise<unknown>;
  label?: string;
  children?: React.ReactNode;
}) {
  const [values, setValues] = useState<Record<string, string | null>>(initial),
    [editing, setEditing] = useState<Record<string, boolean>>({}),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          // Saved masks are presentation only; unchanged credentials never enter a request.
          const data = { ...values };
          for (const f of fields.filter(
            (f) => f.secret && f.configured && !editing[f.key],
          ))
            delete data[f.key];
          await submit(data);
          for (const f of fields.filter((f) => f.secret || f.password))
            setValues((v) => ({ ...v, [f.key]: "" }));
          setEditing({});
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Stack gap="md">
        {fields.map((f) =>
          f.options ? (
            <Select
              key={f.key}
              label={f.label}
              data={f.options}
              value={values[f.key] ?? null}
              onChange={(value) => setValues({ ...values, [f.key]: value })}
              required={!f.optional}
            />
          ) : f.password ? (
            <PasswordInput
              key={f.key}
              label={f.label}
              value={values[f.key] ?? ""}
              onChange={(e) =>
                setValues({ ...values, [f.key]: e.currentTarget.value })
              }
              required={!f.optional}
              autoComplete={f.password}
            />
          ) : f.secret ? (
            <Stack key={f.key} gap="xs">
              <TextInput
                label={f.label}
                type="text"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                data-lpignore="true"
                data-1p-ignore="true"
                value={
                  f.configured && !editing[f.key]
                    ? "********"
                    : (values[f.key] ?? "")
                }
                readOnly={f.configured && !editing[f.key]}
                placeholder="新しい値を入力"
                description={
                  f.configured
                    ? "保存済みの値を使用します。変更する場合だけ入力してください。"
                    : "未設定です。保存すると入力欄から値を消去します。"
                }
                onChange={(e) =>
                  setValues({ ...values, [f.key]: e.currentTarget.value })
                }
                required={!f.optional && (!f.configured || editing[f.key])}
              />
              <Group gap="xs">
                <Badge color={f.configured ? "teal" : "gray"} variant="light">
                  {f.configured ? "設定済み" : "未設定"}
                </Badge>
                {f.configured && (
                  <Button
                    type="button"
                    variant="subtle"
                    size="xs"
                    disabled={busy}
                    aria-label={`${f.label}を${editing[f.key] ? "変更せずに戻る" : "変更"}`}
                    onClick={() => {
                      setValues((v) => ({ ...v, [f.key]: "" }));
                      setEditing((v) => ({ ...v, [f.key]: !v[f.key] }));
                    }}
                  >
                    {editing[f.key] ? "変更せずに戻る" : "変更"}
                  </Button>
                )}
              </Group>
            </Stack>
          ) : f.multiline ? (
            <Textarea
              key={f.key}
              label={f.label}
              minRows={3}
              autosize
              value={values[f.key] ?? ""}
              onChange={(e) =>
                setValues({ ...values, [f.key]: e.currentTarget.value })
              }
              required={!f.optional}
            />
          ) : (
            <TextInput
              key={f.key}
              label={f.label}
              placeholder={f.placeholder}
              rightSectionWidth={f.pick ? 86 : undefined}
              rightSection={
                f.pick ? (
                  <Button
                    size="xs"
                    variant="light"
                    onClick={async () => {
                      try {
                        const picked = await f.pick!();
                        if (picked)
                          setValues((v) => ({ ...v, [f.key]: picked }));
                      } catch {
                        setError(
                          "フォルダーを選択できません。実行を停止して再試行してください。",
                        );
                      }
                    }}
                  >
                    選択
                  </Button>
                ) : undefined
              }
              value={values[f.key] ?? ""}
              onChange={(e) =>
                setValues({ ...values, [f.key]: e.currentTarget.value })
              }
              required={!f.optional}
            />
          ),
        )}
        {children}
        {error && <Alert color="red">{error}</Alert>}
        <Button type="submit" loading={busy} w="fit-content">
          {label}
        </Button>
      </Stack>
    </form>
  );
}
