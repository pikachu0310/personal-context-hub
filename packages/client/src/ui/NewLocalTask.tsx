import { ComposerDropdown, ComposerModelPicker } from "./ComposerDropdown.js";
import { ComposerAction } from "./ComposerAction.js";
import { useEffect, useRef, useState } from "react";
import type { Action } from "@ido/common-ui";
import { desktopBridge } from "./desktop.js";
import type { AgentCatalogEntry } from "@ido/common/contracts/api";

export function NewLocalTask({
  action,
  started,
  mode,
  projects,
  initialProjectId,
  initialDirectory,
}: {
  projects: Array<{ id: string; name: string }>;
  initialProjectId?: string;
  initialDirectory?: string;
  action: Action;
  started: (runId: string) => void;
  mode: "auto" | "manual";
}) {
  const [directory, setDirectory] = useState(initialDirectory ?? "");
  const [detailsOpen, setDetailsOpen] = useState(!initialDirectory);
  const [shareDiscord, setShareDiscord] = useState(true);
  const [shareProjectId, setShareProjectId] = useState(
    initialProjectId ?? projects[0]?.id ?? "",
  );
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [progressMode, setMode] = useState(mode);
  const [accessMode, setAccessMode] = useState("approval");
  const [requestedAgent, setAgent] = useState("");
  const [effort, setEffort] = useState("");
  const [models, setModels] = useState<Record<string, string>>({});
  const [catalog, setCatalog] = useState<AgentCatalogEntry[]>([]);
  const [loadingModels, setLoadingModels] = useState(true);
  const [modelError, setModelError] = useState("");
  const actionRef = useRef(action);
  actionRef.current = action;
  const fetching = useRef(false);
  const mounted = useRef(true);
  async function refreshModels() {
    if (fetching.current) return;
    fetching.current = true;
    setLoadingModels(true);
    setCatalog([]);
    setModelError("");
    try {
      const result = await actionRef.current("agents/models", {});
      if (!result.agents) throw new Error("NO_CATALOG");
      if (mounted.current) setCatalog(result.agents);
    } catch {
      if (mounted.current)
        setModelError(
          "ログイン状況とモデル一覧を取得できませんでした。再確認してください。",
        );
    } finally {
      fetching.current = false;
      if (mounted.current) setLoadingModels(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refreshModels();
    const refresh = () => {
      void refreshModels();
    };
    const timer = setInterval(refresh, 60000);
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const available = catalog.filter((value) => value.authenticated);
  const agent =
    available.find((value) => value.agent === requestedAgent)?.agent ??
    available[0]?.agent ??
    "";
  const options =
    available.find((value) => value.agent === agent)?.models ?? [];
  const model =
    models[agent] === undefined
      ? (options[0]?.id ?? "")
      : (options.find((value) => value.id === models[agent])?.id ?? "");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ fingerprint: string; key: string }>(undefined);
  async function submit() {
    if (
      busy ||
      loadingModels ||
      !agent ||
      !model ||
      !text.trim() ||
      !directory.trim() ||
      (shareDiscord && !shareProjectId)
    )
      return;
    const input = {
      agent,
      model,
      reasoningEffort: options
        .find((entry) => entry.id === model)
        ?.supportedEfforts?.includes(effort)
        ? effort
        : undefined,
      shareDiscord,
      shareProjectId,

      directory,
      title,
      text,
      mode: progressMode,
      accessMode: progressMode === "auto" ? "full" : accessMode,
    };
    const fingerprint = JSON.stringify(input);
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, key: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const result = await action("local-tasks/start", {
        ...input,
        requestKey: request.current.key,
      });
      if (!result.runId) throw new Error("START_UNCONFIRMED");
      started(result.runId);
    } catch (error) {
      setError(
        (
          {
            LOCAL_SLOTS_FULL:
              "同時実行枠が埋まっています。実行中のタスクが終わるか、停止してから開始してください。",
            COMMITTED_REPOSITORY_REQUIRED:
              "コミットがあるGitリポジトリを選択してください。",
            AGENT_LOGIN_REQUIRED:
              "ログインが切れています。接続とセットアップでログインして、一覧を再確認してください。",
            MODEL_UNAVAILABLE:
              "選択したモデルは現在利用できません。一覧を再確認してください。",
            SHARE_PROJECT_REQUIRED:
              "共有先のチームとプロジェクトを設定してください。PC内だけで実行する場合は共有を外してください。",
            INVALID_TEXT: "作業フォルダーと依頼内容を入力してください。",
            INVALID_MODEL:
              "モデルIDを確認してください。空白や改行は使えません。",
          } as Record<string, string>
        )[(error as Error).message] ??
          "開始を確認できませんでした。フォルダーとアプリの状態を確認してください。同じ内容の再送では重複して開始しません。",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="new-task-composer">
      <details
        className="new-task-details"
        open={detailsOpen}
        onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
      >
        <summary>保存先・共有設定</summary>
        <div className="new-task-fields">
          <label>
            タイトル
            <input
              aria-label="タイトル"
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              maxLength={200}
              placeholder="任意"
            />
          </label>
          <label>
            Gitリポジトリのフォルダー
            <input
              aria-label="Gitリポジトリのフォルダー"
              value={directory}
              onChange={(event) => setDirectory(event.currentTarget.value)}
              required
            />
          </label>
          {desktopBridge() && (
            <button
              type="button"
              className="composer-dropdown"
              onClick={() => {
                void desktopBridge()!
                  .pickDirectory()
                  .then((path) => {
                    if (path) setDirectory(path);
                  })
                  .catch(() => setError("フォルダー選択を開けませんでした。"));
              }}
            >
              フォルダーを選択
            </button>
          )}
          <ComposerDropdown
            label="Discordにも共有"
            value={shareDiscord ? "yes" : "no"}
            options={[
              { value: "yes", label: "Discordにも共有" },
              { value: "no", label: "このPCのみ" },
            ]}
            onChange={(value) => setShareDiscord(value === "yes")}
          />
          {shareDiscord && (
            <ComposerDropdown
              label="共有先プロジェクト"
              value={shareProjectId}
              options={projects.map((project) => ({
                value: project.id,
                label: project.name,
              }))}
              onChange={setShareProjectId}
            />
          )}
        </div>
      </details>
      <div className="composer-dock">
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <textarea
            aria-label="依頼内容"
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
            required
            maxLength={16000}
            disabled={busy}
            placeholder="何を進めますか？"
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="composer-toolbar">
            <ComposerDropdown
              label="入力欄の進め方"
              value={progressMode}
              disabled={busy}
              options={[
                { value: "auto", label: "Auto" },
                { value: "manual", label: "Manual" },
              ]}
              onChange={(value) => setMode(value as "auto" | "manual")}
            />
            <ComposerDropdown
              label="実行権限"
              value={progressMode === "auto" ? "full" : accessMode}
              disabled={busy}
              options={
                progressMode === "auto"
                  ? [{ value: "full", label: "フルアクセス（Auto）" }]
                  : [
                      { value: "approval", label: "許可を求める" },
                      { value: "full", label: "フルアクセス" },
                    ]
              }
              onChange={(value) => {
                if (progressMode === "manual") setAccessMode(value);
              }}
            />
            <span className="composer-spacer" />
            <ComposerDropdown
              label="エージェント"
              value={agent || "確認中…"}
              disabled={busy || loadingModels || !available.length}
              options={available.map((entry) => ({
                value: entry.agent,
                label: entry.agent === "claude" ? "Claude Code" : "Codex",
              }))}
              onChange={(value) => {
                setAgent(value);
                setEffort("");
              }}
            />
            <ComposerModelPicker
              models={options}
              model={model}
              effort={
                options
                  .find((entry) => entry.id === model)
                  ?.supportedEfforts?.includes(effort)
                  ? effort
                  : undefined
              }
              disabled={busy || loadingModels}
              onChange={(value, nextEffort) => {
                setModels({ ...models, [agent]: value });
                setEffort(nextEffort ?? "");
              }}
            />
            <ComposerAction
              running={false}
              text={text}
              busy={busy}
              canSend={
                !loadingModels &&
                !!agent &&
                !!model &&
                !!directory.trim() &&
                (!shareDiscord || !!shareProjectId)
              }
              sendLabel={
                progressMode === "manual" ? "相談を開始" : "ローカルで開始"
              }
            />
          </div>
        </form>
        <p className="composer-footnote">
          Enterで送信 · Shift + Enterで改行<span>行動ログはこのPCに保存</span>
        </p>
        {(modelError || !available.length) && (
          <div role="status">
            {modelError || "ログイン済みのエージェントを確認してください。"}
            <button
              type="button"
              className="composer-dropdown"
              disabled={loadingModels}
              onClick={() => void refreshModels()}
            >
              モデル一覧を更新
            </button>
          </div>
        )}
        {error && <p role="alert">{error}</p>}
      </div>
    </div>
  );
}
