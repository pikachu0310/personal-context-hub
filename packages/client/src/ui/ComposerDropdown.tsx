import { Icon } from "./Icons.js";
import { Menu, Popover, Slider } from "@mantine/core";
import { useState } from "react";
import type { AgentCatalogEntry } from "@ido/common/contracts/api";
export function ComposerDropdown({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string; disabled?: boolean }[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Menu position="top-start" withinPortal>
      <Menu.Target>
        <button
          type="button"
          className="composer-dropdown"
          aria-label={label}
          disabled={disabled}
        >
          {options.find((option) => option.value === value)?.label ?? value}
          <Icon name="chevronDown" size={14} />
        </button>
      </Menu.Target>
      <Menu.Dropdown>
        {options.map((option) => (
          <Menu.Item
            key={option.value}
            disabled={option.disabled}
            onClick={() => onChange(option.value)}
            rightSection={option.value === value ? "✓" : undefined}
          >
            {option.label}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  );
}
const effortNames: Record<string, string> = {
  none: "なし",
  minimal: "最小",
  low: "軽",
  medium: "標準",
  high: "高",
  xhigh: "最高",
  max: "最大",
  ultra: "超高",
};
export function ComposerModelPicker({
  models,
  model,
  effort,
  disabled,
  onChange,
}: {
  models: AgentCatalogEntry["models"];
  model: string;
  effort?: string;
  disabled?: boolean;
  onChange: (model: string, effort?: string) => void;
}) {
  const [opened, setOpened] = useState(false);
  const current = models.find((entry) => entry.id === model);
  const efforts = current?.supportedEfforts ?? [];
  const selected = effort ?? current?.defaultEffort;
  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      position="top-end"
      width={300}
      withArrow
      shadow="md"
      trapFocus
    >
      <Popover.Target>
        <button
          type="button"
          className="composer-dropdown"
          aria-label="入力欄のモデル"
          disabled={disabled || !models.length}
          onClick={() => setOpened(!opened)}
        >
          {current?.name ?? (model || "モデルを選択")}
          <span className="composer-effort-label">
            {selected ? (effortNames[selected] ?? selected) : "既定"}
          </span>
          <Icon name="chevronDown" size={14} />
        </button>
      </Popover.Target>
      <Popover.Dropdown className="composer-model-menu">
        <div
          className="composer-model-options"
          role="group"
          aria-label="モデル"
        >
          {models.map((entry) => (
            <button
              type="button"
              key={entry.id}
              disabled={disabled}
              aria-pressed={entry.id === model}
              onClick={() => onChange(entry.id)}
            >
              {entry.name}
              <span>{entry.id === model ? "✓" : ""}</span>
            </button>
          ))}
        </div>
        {!!efforts.length && (
          <div className="composer-effort-picker">
            <div className="composer-effort-heading">
              <span>
                推論エフォート ·{" "}
                {effortNames[selected ?? ""] ?? selected ?? "既定"}
              </span>
              <button
                type="button"
                aria-label="推論エフォートを既定に戻す"
                disabled={disabled}
                onClick={() => onChange(model)}
              >
                ↺
              </button>
            </div>
            <Slider
              key={`${model}:${effort ?? "default"}`}
              thumbLabel="入力欄の推論エフォート"
              thumbValueText={(index) =>
                effortNames[efforts[index]] ?? efforts[index]
              }
              size="lg"
              thumbSize={28}
              min={0}
              max={Math.max(1, efforts.length - 1)}
              step={1}
              defaultValue={Math.max(0, efforts.indexOf(selected ?? ""))}
              disabled={disabled || efforts.length < 2}
              marks={efforts.map((_, index) => ({ value: index }))}
              label={(index) => effortNames[efforts[index]] ?? efforts[index]}
              onChangeEnd={(index) => onChange(model, efforts[index])}
            />
          </div>
        )}
      </Popover.Dropdown>
    </Popover>
  );
}
