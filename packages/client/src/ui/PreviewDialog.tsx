import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Stack,
  Text,
  TextInput,
} from "@mantine/core";
import {
  parsePreviewUrl,
  previewPath,
  type PreviewReference,
  type LocalPreview,
} from "@ido/common/contracts/api";
import { api, previewError } from "./api.js";
import "./preview.css";

const stateLabel: Record<LocalPreview["state"], string> = {
  preparing: "取得中",
  prepared: "起動できます",
  starting: "起動準備中",
  running: "起動中",
  stopping: "停止中",
  stopped: "停止済み",
  failed: "失敗",
};
export function PreviewDialog({
  networkFor,
}: {
  networkFor: (projectId: string) => boolean;
}) {
  const [reference, setReference] = useState<PreviewReference>();
  const [owner, setOwner] = useState("");
  const [views, setViews] = useState<LocalPreview[]>([]);
  const [error, setError] = useState("");
  const [network, setNetwork] = useState(false);
  const [mode, setMode] = useState("live");
  const [path, setPath] = useState("/");
  const [appliedPath, setAppliedPath] = useState("/");
  const [width, setWidth] = useState<number | string>(1280);
  const [height, setHeight] = useState<number | string>(800);
  const [busy, setBusy] = useState<string[]>([]);
  const current = useRef("");
  const networkRef = useRef(networkFor);
  networkRef.current = networkFor;
  useEffect(() => {
    const open = (event: Event) => {
      const ref = parsePreviewUrl(String((event as CustomEvent).detail));
      if (!ref) return;
      if (current.current)
        void api("previews/release", { owner: current.current }).catch(
          () => {},
        );
      const key = crypto.randomUUID();
      current.current = key;
      setOwner(key);
      setReference(ref);
      setViews([]);
      setError("");
      setNetwork(networkRef.current(ref.projectId));
      setPath("/");
      setAppliedPath("/");
      setMode("live");
      setBusy([]);
    };
    window.addEventListener("ido-open-preview", open);
    return () => window.removeEventListener("ido-open-preview", open);
  }, []);
  const refresh = useCallback(async () => {
    const result = await api<LocalPreview[]>("previews/state", { owner });
    if (current.current === owner) setViews(result);
  }, [owner]);
  useEffect(() => {
    if (!reference || !owner) return;
    let active = true;
    const prepare = api<LocalPreview[]>("previews/prepare", {
      ...reference,
      owner,
    });
    void prepare
      .then((result) => {
        if (active && current.current === owner) setViews(result);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    let polling = false;
    const timer = setInterval(() => {
      if (polling) return;
      polling = true;
      void refresh()
        .catch((e) => {
          if (active) setError(e.message);
        })
        .finally(() => {
          polling = false;
        });
    }, 1500);
    const release = () => {
      void api("previews/release", { owner }).catch(() => {});
    };
    window.addEventListener("pagehide", release);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("pagehide", release);
      // Preparation may still be resolving when a different comparison is opened.
      void prepare.finally(release).catch(() => {});
      release();
    };
  }, [reference, owner, refresh]);
  const action = async (operation: string, id?: string) => {
    const key = `${operation}:${id ?? "all"}`;
    setBusy((old) => [...old, key]);
    setError("");
    try {
      await api(`previews/${operation}`, {
        owner,
        id,
        network,
        path: ["capture", "inspect"].includes(operation)
          ? previewPath(path)
          : undefined,
        width: Number(width),
        height: Number(height),
      });
      await refresh();
    } catch (e) {
      if (current.current === owner) setError((e as Error).message);
    } finally {
      setBusy((old) => old.filter((v) => v !== key));
    }
  };
  const ordered =
    reference?.implementationIds.flatMap((id) =>
      views.filter((v) => v.implementation.id === id),
    ) ?? [];
  const close = () => {
    current.current = "";
    setReference(undefined);
    setViews([]);
  };
  const showPath = () => {
    try {
      setAppliedPath(previewPath(path));
      for (const view of ordered)
        if (view.state === "running") void action("inspect", view.id);
      setError("");
    } catch {
      setError("対象パスは / から始まるアプリ内のパスを指定してください。");
    }
  };
  const w = Math.max(320, Math.min(2560, Number(width) || 1280)),
    h = Math.max(240, Math.min(1600, Number(height) || 800));
  return (
    <Modal
      opened={!!reference}
      onClose={close}
      title={
        reference?.implementationIds.length === 2 ? "2案を比較" : "実装を起動"
      }
      size="100%"
      className="preview-dialog"
    >
      <Stack>
        <Text size="sm" c="dimmed">
          このPCにコミットを取得し、Codexが起動を準備します。
        </Text>
        <Group justify="space-between">
          <SegmentedControl
            value={mode}
            onChange={setMode}
            data={[
              { label: "操作して比較", value: "live" },
              { label: "画像比較", value: "images" },
            ]}
          />
          <Checkbox
            label="依存関係の準備・起動にネット接続を使う"
            checked={network}
            onChange={(e) => setNetwork(e.currentTarget.checked)}
          />
          <Button
            disabled={
              !ordered.some(
                (v) =>
                  ["prepared", "stopped", "failed"].includes(v.state) &&
                  v.directory,
              )
            }
            onClick={() => {
              for (const v of ordered)
                if (v.directory) void action("start", v.id);
            }}
          >
            起動
          </Button>
        </Group>
        <Group align="end">
          <TextInput
            label="対象パス"
            value={path}
            onChange={(e) => setPath(e.currentTarget.value)}
            placeholder="/"
          />
          <NumberInput
            label="表示幅"
            min={320}
            max={2560}
            value={width}
            onChange={setWidth}
            w={110}
          />
          <NumberInput
            label="表示高さ"
            min={240}
            max={1600}
            value={height}
            onChange={setHeight}
            w={110}
          />
          <Button variant="default" onClick={showPath}>
            パスを表示
          </Button>
          <Button
            variant="default"
            disabled={!ordered.some((v) => v.state === "running")}
            onClick={() => {
              for (const v of ordered)
                if (v.state === "running") void action("capture", v.id);
            }}
          >
            同じ条件で撮影
          </Button>
        </Group>
        {error && (
          <Alert color="red" role="alert">
            {error}
          </Alert>
        )}
        {!ordered.length && !error && (
          <Text role="status">実装情報を確認しています…</Text>
        )}
        <div
          className="preview-columns"
          style={{
            gridTemplateColumns:
              ordered.length > 1
                ? "repeat(2, minmax(0, 1fr))"
                : "minmax(0, 1fr)",
          }}
        >
          {ordered.map((v, index) => (
            <section
              className="preview-pane"
              key={v.id}
              aria-label={`${index === 0 ? "左" : "右"}の実装: ${v.implementation.title}`}
            >
              <Stack gap="xs">
                <Group justify="space-between">
                  <strong>{v.implementation.title}</strong>
                  <Badge>{stateLabel[v.state]}</Badge>
                </Group>
                <Text size="xs" c="dimmed">
                  {v.implementation.branch.replace(/^refs\/heads\//, "")} ·{" "}
                  <code>{v.implementation.commit.slice(0, 12)}</code>
                </Text>
                <Group gap="xs">
                  <Button
                    size="xs"
                    variant="light"
                    disabled={
                      !v.directory ||
                      ["preparing", "starting", "running", "stopping"].includes(
                        v.state,
                      )
                    }
                    loading={busy.includes(`start:${v.id}`)}
                    onClick={() => void action("start", v.id)}
                  >
                    起動・再試行
                  </Button>
                  <Button
                    size="xs"
                    variant="default"
                    disabled={["stopped", "prepared"].includes(v.state)}
                    onClick={() => void action("stop", v.id)}
                  >
                    停止
                  </Button>
                  {v.url && (
                    <Button
                      component="a"
                      size="xs"
                      variant="subtle"
                      href={v.url + appliedPath}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      別タブで開く
                    </Button>
                  )}
                  <Button
                    size="xs"
                    color="gray"
                    variant="subtle"
                    disabled={
                      !["stopped", "prepared", "failed"].includes(v.state)
                    }
                    onClick={() => void action("remove", v.id)}
                  >
                    worktreeを削除
                  </Button>
                </Group>
                {v.error && <Alert color="red">{previewError(v.error)}</Alert>}
                {v.state === "failed" && !v.directory && (
                  <Button
                    variant="light"
                    onClick={() =>
                      void api("previews/prepare", { ...reference, owner })
                        .then(refresh)
                        .catch((e) => setError(e.message))
                    }
                  >
                    取得を再試行
                  </Button>
                )}
                {mode === "live" &&
                  v.url &&
                  !(v.frameBlocked && v.frameBlockedPath === appliedPath) && (
                    <ScaledPreview
                      url={v.url + appliedPath}
                      width={w}
                      height={h}
                      title={v.implementation.title}
                    />
                  )}
                {mode === "live" &&
                  v.frameBlocked &&
                  v.frameBlockedPath === appliedPath && (
                    <Alert color="yellow">
                      このアプリは埋め込み表示を許可していません。画像比較または別タブで確認できます。
                    </Alert>
                  )}
                {mode === "images" && v.capture && (
                  <>
                    <img
                      className="preview-capture"
                      src={v.capture.url}
                      alt={`${v.implementation.title}の実装画面`}
                    />
                    <Text size="xs" c="dimmed">
                      {v.capture.path} · {v.capture.width}×{v.capture.height} ·{" "}
                      {v.capture.commit.slice(0, 12)} ·{" "}
                      {new Date(v.capture.at).toLocaleString()}
                    </Text>
                  </>
                )}
                {mode === "images" && !v.capture && (
                  <Text size="sm">起動後に画面を撮影します。</Text>
                )}
                {v.captureError && (
                  <Alert color="yellow">
                    {v.captureError === "PREVIEW_BROWSER_REQUIRED"
                      ? "撮影用ブラウザのセットアップが必要です。"
                      : previewError(v.captureError)}
                    {v.captureError === "PREVIEW_BROWSER_REQUIRED" && (
                      <Button
                        mt="xs"
                        size="xs"
                        loading={busy.includes("install-browser:all")}
                        onClick={() =>
                          void action("install-browser").then(() =>
                            action("capture", v.id),
                          )
                        }
                      >
                        撮影用ブラウザをセットアップ
                      </Button>
                    )}
                  </Alert>
                )}
                <details>
                  <summary>起動ログ</summary>
                  <pre className="preview-log">
                    {v.log ||
                      "起動ボタンを押すと、ここに準備状況が表示されます。"}
                  </pre>
                </details>
              </Stack>
            </section>
          ))}
        </div>
      </Stack>
    </Modal>
  );
}
function ScaledPreview({
  url,
  width,
  height,
  title,
}: {
  url: string;
  width: number;
  height: number;
  title: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(width);
  useEffect(() => {
    const observer = new ResizeObserver(() =>
      setAvailable(host.current?.clientWidth ?? width),
    );
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, [width]);
  const scale = Math.min(1, available / width);
  return (
    <div
      ref={host}
      className="preview-viewport"
      style={{ height: height * scale }}
    >
      <iframe
        title={`${title}の操作画面`}
        src={url}
        width={width}
        height={height}
        sandbox="allow-scripts allow-same-origin allow-forms"
        referrerPolicy="no-referrer"
        style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}
      />
    </div>
  );
}
