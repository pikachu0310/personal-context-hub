import { ComposerDropdown, ComposerModelPicker } from "./ComposerDropdown.js";
import { useEffect, useState } from "react";
import type { AgentCatalogEntry } from "@ido/common/contracts/api";
import { api } from "./api.js";

export function ModelControls({
  runId,
  projectId,
  agent = "codex",
  onBusyChange,
}: {
  runId?: string;
  projectId?: string;
  agent?: string;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [catalog, setCatalog] = useState<AgentCatalogEntry[]>([]);
  const [selection, setSelection] = useState<{
    agent?: string;
    model?: string;
    reasoningEffort?: string;
    progressMode?: "auto" | "manual";
  }>({});
  const [busy, setBusy] = useState(false);
  const selectedAgent = projectId ? (selection.agent ?? agent) : agent;
  const models =
    catalog.find(
      (entry) => entry.agent === selectedAgent && entry.authenticated,
    )?.models ?? [];
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      try {
        const [catalog, settings] = await Promise.all([
          api<{ agents: AgentCatalogEntry[] }>("agents/models", {}),
          api<typeof selection>("model-settings", {
            runId,
            projectId,
            read: true,
          }),
        ]);
        if (!disposed) {
          setCatalog(catalog.agents);
          setSelection(settings);
          setError("");
        }
      } catch {
        if (!disposed)
          setError(
            "モデル一覧を取得できません。ログインと接続設定を確認してください。",
          );
      }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
    };
  }, [runId, projectId, agent]);
  async function save(
    model: string,
    reasoningEffort?: string,
    provider = selectedAgent,
  ) {
    setBusy(true);
    onBusyChange?.(true);
    try {
      const result = await api<typeof selection>("model-settings", {
        runId,
        projectId,
        model,
        reasoningEffort,
        agent: provider,
      });
      setSelection(result);
      setError("");
    } catch {
      setError(
        "保存できませんでした。ログイン状況とモデルの対応値を確認してください。",
      );
    } finally {
      setBusy(false);
      onBusyChange?.(false);
    }
  }
  return (
    <div
      className={
        projectId
          ? "composer-model-controls composer-project-controls"
          : "composer-model-controls"
      }
    >
      {projectId && (
        <ComposerDropdown
          label="入力欄の進め方"
          value={selection.progressMode ?? "auto"}
          disabled={busy}
          options={[
            { value: "auto", label: "Auto" },
            { value: "manual", label: "Manual" },
          ]}
          onChange={async (value) => {
            const mode = value as "auto" | "manual";
            setBusy(true);
            onBusyChange?.(true);
            try {
              await api("progress-mode", { projectId, mode });
              setSelection((previous) => ({ ...previous, progressMode: mode }));
              setError("");
            } catch {
              setError("進め方を保存できませんでした。");
            } finally {
              setBusy(false);
              onBusyChange?.(false);
            }
          }}
        />
      )}
      {projectId && (
        <ComposerDropdown
          label="エージェント"
          value={selectedAgent}
          disabled={busy}
          options={catalog
            .filter((entry) => entry.authenticated)
            .map((entry) => ({
              value: entry.agent,
              label: entry.agent === "claude" ? "Claude" : "Codex",
            }))}
          onChange={(provider) => {
            const model = catalog.find((entry) => entry.agent === provider)
              ?.models[0];
            if (model) void save(model.id, undefined, provider);
          }}
        />
      )}
      {projectId && <span className="composer-spacer" />}
      <ComposerModelPicker
        models={models}
        model={selection.model ?? ""}
        effort={selection.reasoningEffort}
        disabled={busy}
        onChange={(model, effort) => void save(model, effort)}
      />
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
