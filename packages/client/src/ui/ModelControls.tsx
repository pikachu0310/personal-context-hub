import { ComposerDropdown, ComposerModelPicker } from "./ComposerDropdown.js";
import { useEffect, useState } from "react";
import type { AgentCatalogEntry } from "@ido/common/contracts/api";
import { api } from "./api.js";

export function ModelControls({
  runId,
  projectId,
  agent = "codex",
}: {
  runId?: string;
  projectId?: string;
  agent?: string;
}) {
  const [models, setModels] = useState<AgentCatalogEntry["models"]>([]);
  const [selection, setSelection] = useState<{
    model?: string;
    reasoningEffort?: string;
    progressMode?: "auto" | "manual";
  }>({});
  const [busy, setBusy] = useState(false);
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
          setModels(
            catalog.agents.find(
              (entry) => entry.agent === agent && entry.authenticated,
            )?.models ?? [],
          );
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
  async function save(model: string, reasoningEffort?: string) {
    setBusy(true);
    try {
      const result = await api<typeof selection>("model-settings", {
        runId,
        projectId,
        model,
        reasoningEffort,
      });
      setSelection(result);
      setError("");
    } catch {
      setError(
        "保存できませんでした。ログイン状況とモデルの対応値を確認してください。",
      );
    } finally {
      setBusy(false);
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
            try {
              await api("progress-mode", { projectId, mode });
              setSelection((previous) => ({ ...previous, progressMode: mode }));
              setError("");
            } catch {
              setError("進め方を保存できませんでした。");
            } finally {
              setBusy(false);
            }
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
