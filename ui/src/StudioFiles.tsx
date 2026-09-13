import { useEffect, useRef, useState } from "react";
import { Download, FileText, LoaderCircle, RefreshCw, X } from "lucide-react";

export type StudioRequester = (
  path: string,
  options?: RequestInit,
  asBlob?: boolean,
) => Promise<unknown>;
type ResultFile = {
  id: string;
  name: string;
  size: number;
  downloadable: boolean;
};
type Manifest = {
  runRevision: number;
  available: boolean;
  truncated?: boolean;
  files: ResultFile[];
};
const readable =
  /\.(txt|md|markdown|json|csv|tsv|js|mjs|cjs|jsx|ts|tsx|html|css|yml|yaml|py|go|rs|cs|sh|sql|xml|toml)$/i;
const fileSize = (size: number) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${Math.ceil(size / 1024)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;

export function StudioFiles({
  taskId,
  runRevision,
  roomId,
  request,
  hideEmpty = false,
}: {
  taskId: string;
  runRevision: number;
  roomId: string;
  request: StudioRequester;
  hideEmpty?: boolean;
}) {
  const [manifest, setManifest] = useState<Manifest>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [retry, setRetry] = useState(0);
  const [opened, setOpened] = useState<{ name: string; text: string }>();
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!opened) return;
    content.current?.focus({ preventScroll: true });
    content.current?.scrollIntoView({
      block: "nearest",
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  }, [opened]);
  const query = new URLSearchParams({
    taskId,
    runRevision: String(runRevision),
  }).toString();
  const base = `/api/studio/rooms/${roomId}`;
  useEffect(() => {
    const abort = new AbortController();
    setManifest(undefined);
    setError("");
    setOpened(undefined);
    request(`${base}/artifacts?${query}`, { signal: abort.signal })
      .then((value) => {
        if (!abort.signal.aborted) setManifest(value as Manifest);
      })
      .catch((failure) => {
        if (!abort.signal.aborted) setError((failure as Error).message);
      });
    return () => abort.abort();
  }, [base, query, request, retry]);
  async function getFile(file: ResultFile, inspect = false) {
    setBusy(file.id);
    setError("");
    try {
      const blob = (await request(
        `${base}/files?${query}&fileId=${file.id}`,
        {},
        true,
      )) as Blob;
      if (inspect) setOpened({ name: file.name, text: await blob.text() });
      else {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.name.split("/").at(-1) ?? "result";
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
      }
    } catch (failure) {
      setError((failure as Error).message);
    } finally {
      setBusy("");
    }
  }
  if (hideEmpty && manifest && !manifest.files.length && !error) return null;
  return (
    <section className="result-files" aria-label="成果ファイル">
      <header>
        <h3>成果ファイル</h3>
        <span className="muted">実行 {runRevision} の保存済みファイル</span>
      </header>
      {error && (
        <div className="file-error" role="alert">
          <p>{error}</p>
          <button
            className="button-secondary"
            onClick={() => setRetry((value) => value + 1)}
          >
            <RefreshCw size={15} />
            読み直す
          </button>
        </div>
      )}
      {!manifest && !error && (
        <p className="file-loading" role="status">
          <LoaderCircle className="spin" size={16} />
          成果ファイルを読み込んでいます
        </p>
      )}
      {manifest && !manifest.files.length && (
        <p className="muted">
          {manifest.available
            ? "この実行には、取得できる追加・変更ファイルがありません。結果の説明を確認してください。"
            : "この結果には取得できるファイルがありません。結果の説明やDiscordの添付を確認してください。"}
        </p>
      )}
      {manifest && manifest.files.length > 0 && (
        <ul>
          {manifest.files.map((file) => (
            <li key={file.id}>
              <FileText size={18} />
              <div className="result-file-name">
                <span>{file.name}</span>
                <small>{fileSize(file.size)}</small>
              </div>
              <div className="result-file-actions">
                {readable.test(file.name) && file.size <= 256 * 1024 && (
                  <button
                    className="button-quiet"
                    disabled={Boolean(busy)}
                    onClick={() => void getFile(file, true)}
                  >
                    内容を見る
                  </button>
                )}
                <button
                  className="button-secondary"
                  disabled={Boolean(busy) || !file.downloadable}
                  onClick={() => void getFile(file)}
                  aria-label={`${file.name}を保存`}
                >
                  {busy === file.id ? (
                    <LoaderCircle className="spin" size={15} />
                  ) : (
                    <Download size={15} />
                  )}
                  {file.downloadable ? "保存" : "8MB超"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {manifest?.truncated && (
        <p className="muted">変更された先頭200件を表示しています。</p>
      )}
      {opened && (
        <div
          className="result-file-content"
          ref={content}
          tabIndex={-1}
          aria-label={`${opened.name}の内容`}
        >
          <header>
            <strong>{opened.name}</strong>
            <button
              className="icon-button"
              aria-label="ファイルの内容を閉じる"
              onClick={() => setOpened(undefined)}
            >
              <X size={17} />
            </button>
          </header>
          <pre>{opened.text}</pre>
        </div>
      )}
    </section>
  );
}
