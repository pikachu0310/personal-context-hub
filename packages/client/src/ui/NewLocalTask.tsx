import { useRef, useState } from "react";
import type { Action } from "@ido/common-ui";
import { desktopBridge } from "./desktop.js";
import { claudeModels } from "../agents/model-selection.js";

export function NewLocalTask({
  action,
  started,
  mode,
}: {
  action: Action;
  started: (runId: string) => void;
  mode: "auto" | "manual";
}) {
  const [directory, setDirectory] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [progressMode, setMode] = useState(mode);
  const [network, setNetwork] = useState(false);
  const [agent, setAgent] = useState("codex");
  const [models, setModels] = useState<Record<string, string>>({});
  const [customModels, setCustomModels] = useState<Record<string, string>>({});
  const [codexOptions, setCodexOptions] = useState<
    Array<{ id: string; name: string }>
  >([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelError, setModelError] = useState("");
  const modelChoice = models[agent] ?? "";
  const model =
    modelChoice === "custom" ? (customModels[agent] ?? "") : modelChoice;
  const [claudePermissionsAcknowledged, acknowledgeClaude] = useState(false);
  const [sandbox, setSandbox] = useState("workspace-write");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ fingerprint: string; key: string }>(undefined);
  async function submit() {
    if (busy) return;
    const input = {
      agent,
      model,
      claudePermissionsAcknowledged,
      directory,
      title,
      text,
      mode: progressMode,
      network,
      sandboxMode: sandbox,
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
    <div className="setup-scroll">
      <div className="setup-content">
        <h2>新しいローカルタスク</h2>
        <p>実験・調査・実装を、このPCから開始します。Botとの接続は不要です。</p>
        <form
          className="local-task-form"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <fieldset disabled={busy}>
            <label>
              エージェント
              <select
                aria-label="エージェント"
                value={agent}
                onChange={(event) => setAgent(event.currentTarget.value)}
              >
                <option value="codex">Codex</option>
                <option value="claude">Claude Code</option>
              </select>
            </label>
            <label>
              使用するモデル
              <select
                aria-label="使用するモデル"
                value={modelChoice}
                onChange={(event) =>
                  setModels({ ...models, [agent]: event.currentTarget.value })
                }
              >
                <option value="">既定モデル（エージェント設定に従う）</option>
                {(agent === "claude" ? claudeModels : codexOptions).map(
                  (value) => (
                    <option key={value.id} value={value.id}>
                      {value.name}
                    </option>
                  ),
                )}
                <option value="custom">モデルIDを指定…</option>
              </select>
            </label>
            {modelChoice === "custom" && (
              <label>
                モデルID
                <input
                  aria-label="モデルID"
                  value={customModels[agent] ?? ""}
                  required
                  maxLength={128}
                  onChange={(event) =>
                    setCustomModels({
                      ...customModels,
                      [agent]: event.currentTarget.value,
                    })
                  }
                />
              </label>
            )}
            {agent === "codex" && (
              <>
                <button
                  type="button"
                  className="soft-button"
                  disabled={loadingModels}
                  onClick={() => {
                    setLoadingModels(true);
                    setModelError("");
                    void action("agents/models", {})
                      .then((result) => {
                        if (!result.models?.length)
                          throw new Error("NO_MODELS");
                        setCodexOptions(result.models);
                      })
                      .catch(() =>
                        setModelError(
                          "モデル一覧を取得できませんでした。Codexのログイン状態を確認して再取得するか、モデルIDを指定してください。",
                        ),
                      )
                      .finally(() => setLoadingModels(false));
                  }}
                >
                  {loadingModels
                    ? "モデルを取得中…"
                    : "Codexのモデル一覧を取得・更新"}
                </button>
                {modelError && <p role="alert">{modelError}</p>}
              </>
            )}
            <p>
              選択したモデルはこのタスクの相談・実行・追加指示に適用します。利用可否はログイン中のアカウントによって異なります。
            </p>
            <label>
              タイトル
              <input
                value={title}
                onChange={(event) => setTitle(event.currentTarget.value)}
                maxLength={200}
                placeholder="例：新しい処理方式を試す"
              />
            </label>
            <label>
              Gitリポジトリのフォルダー
              <input
                value={directory}
                onChange={(event) => setDirectory(event.currentTarget.value)}
                required
                placeholder="作業するリポジトリの絶対パス"
              />
            </label>
            {desktopBridge() && (
              <button
                type="button"
                className="soft-button"
                onClick={() => {
                  void desktopBridge()!
                    .pickDirectory()
                    .then((path) => {
                      if (path) setDirectory(path);
                    })
                    .catch(() =>
                      setError(
                        "フォルダー選択を開けませんでした。パスを直接入力してください。",
                      ),
                    );
                }}
              >
                フォルダーを選択
              </button>
            )}
            <p>
              現在のHEADから専用worktreeを作成します。未コミットの変更はコピーされません。
            </p>
            <label>
              依頼内容
              <textarea
                value={text}
                onChange={(event) => setText(event.currentTarget.value)}
                required
                maxLength={16000}
                rows={6}
                placeholder="試したいことや確認したいことを入力"
              />
            </label>
            <label>
              進め方
              <select
                aria-label="進め方"
                value={progressMode}
                onChange={(event) =>
                  setMode(event.currentTarget.value as "auto" | "manual")
                }
              >
                <option value="auto">Auto · 作業を開始</option>
                <option value="manual">Manual · まず相談・計画</option>
              </select>
            </label>
            <label>
              実行権限
              <select
                aria-label="実行権限"
                value={sandbox}
                onChange={(event) => setSandbox(event.currentTarget.value)}
              >
                <option value="workspace-write">
                  {agent === "claude"
                    ? "Claude · 操作ごとに承認"
                    : "専用の作業フォルダー内で変更"}
                </option>
                <option value="read-only">読み取り専用の調査</option>
              </select>
            </label>
            <label className="local-network">
              <input
                type="checkbox"
                checked={network}
                onChange={(event) => setNetwork(event.currentTarget.checked)}
              />
              このタスクの通信を許可する
            </label>
            <p>
              追加権限はアプリで承認します。Botへの進捗共有はまだ接続していません。
            </p>
            {agent === "claude" && (
              <label className="local-network">
                <input
                  type="checkbox"
                  required
                  checked={claudePermissionsAcknowledged}
                  onChange={(event) =>
                    acknowledgeClaude(event.currentTarget.checked)
                  }
                />
                Claudeのツールは操作ごとに承認します。OSサンドボックスではなく、承認したシェル操作はPC全体に影響できます。通信禁止・相談中・読み取り専用の場合はシェルを使いません。
              </label>
            )}
            {error && <p role="alert">{error}</p>}
            <button className="primary-button" type="submit">
              {busy
                ? "開始しています…"
                : progressMode === "manual"
                  ? "相談を開始"
                  : "ローカルで開始"}
            </button>
          </fieldset>
        </form>
      </div>
    </div>
  );
}
