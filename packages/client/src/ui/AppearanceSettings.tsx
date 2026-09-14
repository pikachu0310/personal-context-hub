import {
  SegmentedControl,
  Stack,
  Text,
  useMantineColorScheme,
} from "@mantine/core";

export function AppearanceSettings() {
  const { colorScheme, setColorScheme } = useMantineColorScheme();
  return (
    <Stack gap="sm" className="appearance-settings">
      <Text fw={600} id="appearance-label">
        外観
      </Text>
      <SegmentedControl
        aria-labelledby="appearance-label"
        fullWidth
        value={colorScheme}
        onChange={(value) => {
          if (value === "light" || value === "dark" || value === "auto")
            setColorScheme(value);
        }}
        data={[
          { value: "light", label: "ライト" },
          { value: "dark", label: "ダーク" },
          { value: "auto", label: "システム" },
        ]}
      />
      <Text size="sm" c="dimmed">
        変更はすぐに反映され、この端末に自動保存されます。「システム」はOSの設定に合わせます。
      </Text>
    </Stack>
  );
}
