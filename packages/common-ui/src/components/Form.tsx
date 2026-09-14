import {
  Alert,
  Button,
  PasswordInput,
  Select,
  Stack,
  Textarea,
  TextInput,
} from "@mantine/core";
import React, { useState } from "react";
export type Field = {
  key: string;
  label: string;
  secret?: boolean;
  options?: Array<{ value: string; label: string }>;
  multiline?: boolean;
  placeholder?: string;
  optional?: boolean;
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
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await submit(values);
          for (const f of fields.filter((f) => f.secret))
            setValues((v) => ({ ...v, [f.key]: "" }));
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
          ) : f.secret ? (
            <PasswordInput
              key={f.key}
              label={f.label}
              value={values[f.key] ?? ""}
              onChange={(e) =>
                setValues({ ...values, [f.key]: e.currentTarget.value })
              }
              required={!f.optional}
              autoComplete="new-password"
            />
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
