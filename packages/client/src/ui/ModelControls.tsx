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
  const current = models.find((entry) => entry.id === selection.model);
  return (
    <div className="composer-model-controls">
      {projectId && (
        <select
          aria-label="入力欄の進め方"
          disabled={busy}
          value={selection.progressMode ?? "auto"}
          onChange={async (e) => {
            const mode = e.currentTarget.value as "auto" | "manual";
            setBusy(true);
            try {
              await api("progress-mode", { projectId, mode });
              setSelection((previous) => ({ ...previous, progressMode: mode }));
              setError("");
            } catch {
              setError(
                "進め方を保存できませんでした。接続設定を確認してください。",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <option value="auto">Auto</option>
          <option value="manual">Manual · 会話する</option>
        </select>
      )}

      <label>
        モデル
        <select
          aria-label="入力欄のモデル"
          disabled={busy || !models.length}
          value={selection.model ?? ""}
          onChange={(e) => void save(e.currentTarget.value)}
        >
          {!current && (
            <option value={selection.model ?? ""}>
              {selection.model ?? "既定モデル"}
            </option>
          )}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        推論
        <select
          aria-label="入力欄の推論エフォート"
          disabled={busy || !current?.supportedEfforts?.length}
          value={selection.reasoningEffort ?? ""}
          onChange={(e) =>
            void save(selection.model!, e.currentTarget.value || undefined)
          }
        >
          <option value="">
            既定{current?.defaultEffort ? " · " + current.defaultEffort : ""}
          </option>
          {current?.supportedEfforts?.map((effort) => (
            <option key={effort}>{effort}</option>
          ))}
        </select>
      </label>
      {busy && <small>保存中…</small>}
      {projectId && <small>このPCで新しく受け取るタスクに適用</small>}
      {error && <small role="alert">{error}</small>}
    </div>
  );
}
