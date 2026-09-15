import {
  Alert,
  Button,
  Group,
  Modal,
  Select,
  SegmentedControl,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Icon } from "./Icons.js";

type Artifact = { path: string; title?: string; updatedAt: number };
type ArtifactVersion = Artifact & { id: string; savedAt: number };

export function TaskArtifacts({
  runId,
  version,
  canFollowup,
  onFollowup,
  running,
  executionLabel,
}: {
  runId: string;
  version: string;
  canFollowup: boolean;
  onFollowup: (text: string) => Promise<boolean>;
  running: boolean;
  executionLabel: string;
}) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const previewRequested =
    new URL(location.href).searchParams.get("previewRun") === runId;
  const [opened, setOpened] = useState(previewRequested);
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [loadedAt, setLoadedAt] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  const [currentVersion, setCurrentVersion] = useState<string>();
  const [versions, setVersions] = useState<ArtifactVersion[]>([]);
  const [comparison, setComparison] = useState<string | null>(null);
  const [comparing, setComparing] = useState(false);
  const [exhibit, setExhibit] = useState(
    previewRequested &&
      new URL(location.href).searchParams.get("exhibit") === "1",
  );
  const [fullScreen, setFullScreen] = useState(exhibit);
  const [comparisonLayout, setComparisonLayout] = useState("split");
  const [visibleVersion, setVisibleVersion] = useState("current");
  const [linkCopied, setLinkCopied] = useState(false);
  const [requestedAt, setRequestedAt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running || !requestedAt) return;
    const update = () =>
      setElapsed(Math.floor((Date.now() - requestedAt) / 1000));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [running, requestedAt]);
  useEffect(() => {
    let active = true;
    void api<{ artifacts: Artifact[] }>(
      `artifacts?runId=${encodeURIComponent(runId)}`,
    )
      .then((data) => {
        if (!active) return;
        setArtifacts(data.artifacts);
        setSelected((current) =>
          data.artifacts.some((a) => a.path === current)
            ? current
            : (data.artifacts[0]?.path ?? null),
        );
      })
      .catch(() => {
        if (active) setArtifacts([]);
      });
    return () => {
      active = false;
    };
  }, [runId, version, refresh]);
  useEffect(() => {
    if (!opened || !selected) return;
    let active = true;
    setHtml(undefined);
    setFrameReady(false);
    setError("");
    void api<{
      html: string;
      updatedAt: number;
      version: ArtifactVersion;
      versions: ArtifactVersion[];
    }>(
      `artifacts?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(selected)}`,
    )
      .then((value) => {
        if (active) {
          setHtml(value.html);
          setLoadedAt(value.updatedAt);
          setCurrentVersion(value.version.id);
          const previous = value.versions.filter(
            (v) => v.path === selected && v.id !== value.version.id,
          );
          setVersions(previous);
          setComparison((current) =>
            previous.some((v) => v.id === current)
              ? current
              : (previous[0]?.id ?? null),
          );
        }
      })
      .catch(() => {
        if (active)
          setError(
            "試作を読み込めませんでした。更新してもう一度開いてください。",
          );
      });
    return () => {
      active = false;
    };
  }, [runId, selected, opened, refresh]);
  if (!artifacts.length) return null;
  const updated =
    (artifacts.find((a) => a.path === selected)?.updatedAt ?? 0) > loadedAt + 1;
  const documentUrl = (versionId: string) =>
    `/api/artifact-document?runId=${encodeURIComponent(runId)}&version=${encodeURIComponent(versionId)}`;
  const versionLabel = (value: ArtifactVersion) =>
    new Date(value.savedAt).toLocaleString("ja-JP", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  return (
    <>
      <div className="task-artifacts" aria-label="触れる試作">
        <div>
          <Text size="sm" fw={650}>
            触って、次のアイデアへ。
          </Text>
          <Text size="xs" c="dimmed">
            {artifacts.length}件の試作 · 感想をこのタスクに返せます
          </Text>
        </div>
        <Button
          variant="light"
          leftSection={<Icon name="computer" />}
          onClick={() => setOpened(true)}
        >
          試作を開く
        </Button>
      </div>
      <Modal
        opened={opened}
        onClose={() => setOpened(false)}
        title={exhibit ? "会議の続きを、動くもので。" : "試して、その場で直す"}
        size="calc(100vw - 3rem)"
        className="artifact-modal"
        transitionProps={{ duration: 0 }}
        centered
        fullScreen={fullScreen}
      >
        <Stack gap="md">
          {exhibit && (
            <div className="artifact-exhibit-intro">
              <div>
                <Text size="xl" fw={750}>
                  まずは触って、変えたいところをひとつ。
                </Text>
                <Text size="sm" c="dimmed">
                  感想を伝えると、このタスクのAIが続きを作ります。
                </Text>
              </div>
              <div className="artifact-exhibit-steps">
                <span>01 触ってみる</span>
                <span>02 感想を返す</span>
                <span>03 修正前と比べる</span>
              </div>
            </div>
          )}
          <Group justify="space-between" wrap="wrap">
            <Select
              aria-label="表示する試作"
              data={artifacts.map((a) => ({
                value: a.path,
                label: a.title || a.path,
              }))}
              value={selected}
              onChange={setSelected}
              allowDeselect={false}
              className="artifact-select"
            />
            <Button
              variant={updated ? "filled" : "default"}
              onClick={() => setRefresh((v) => v + 1)}
              leftSection={<Icon name="refresh" />}
            >
              {updated ? "修正が届きました · 最新版を開く" : "最新版を読み込む"}
            </Button>
            {versions.length > 0 && (
              <Button
                variant={comparing ? "light" : "default"}
                onClick={() => setComparing((value) => !value)}
              >
                {comparing ? "比較を閉じる" : "修正前と比べる"}
              </Button>
            )}
            <Button
              variant="subtle"
              onClick={() => setFullScreen((value) => !value)}
            >
              {fullScreen ? "通常表示に戻す" : "大きく表示"}
            </Button>
            <Button
              variant="subtle"
              onClick={() => {
                setExhibit((value) => !value);
                setFullScreen(!exhibit);
              }}
            >
              {exhibit ? "展示表示を終える" : "展示表示"}
            </Button>
            {exhibit && (
              <Button
                variant="subtle"
                onClick={async () => {
                  const url = new URL(location.origin);
                  url.searchParams.set("previewRun", runId);
                  url.searchParams.set("exhibit", "1");
                  try {
                    await navigator.clipboard.writeText(url.href);
                    setLinkCopied(true);
                  } catch {
                    setNotice(`この端末で開く展示用リンク: ${url.href}`);
                  }
                }}
              >
                {linkCopied ? "コピーしました" : "この表示のリンクをコピー"}
              </Button>
            )}
          </Group>
          {(running || updated) && (
            <div
              className="artifact-progress"
              role="status"
              data-running={running || undefined}
            >
              <span className="artifact-progress-dot" />
              <Text size="sm">
                {running
                  ? `${executionLabel}${requestedAt ? ` · 依頼から${Math.floor(elapsed / 60)}分${elapsed % 60}秒` : ""}。待っている間も、開いた試作を操作できます。`
                  : "修正が届きました。最新版を開いて、前の版と比べてみてください。"}
              </Text>
            </div>
          )}
          {comparing && versions.length > 0 && (
            <Select
              label="比較する版"
              value={comparison}
              onChange={setComparison}
              allowDeselect={false}
              data={versions.map((v) => ({
                value: v.id,
                label: `${versionLabel(v)}に開いた版`,
              }))}
            />
          )}
          {comparing && comparison && (
            <Group>
              <SegmentedControl
                aria-label="比較の並べ方"
                value={comparisonLayout}
                onChange={setComparisonLayout}
                data={[
                  { value: "split", label: "並べて見る" },
                  { value: "switch", label: "切り替えて見る" },
                ]}
              />
              {comparisonLayout === "switch" && (
                <SegmentedControl
                  aria-label="操作する版"
                  value={visibleVersion}
                  onChange={setVisibleVersion}
                  data={[
                    { value: "previous", label: "修正前" },
                    { value: "current", label: "いまの版" },
                  ]}
                />
              )}
            </Group>
          )}
          {error && <Alert color="red">{error}</Alert>}
          {html === undefined || !currentVersion ? (
            <Text role="status">{error ? "" : "試作を読み込んでいます…"}</Text>
          ) : (
            <div
              className="artifact-comparison"
              data-comparing={
                (comparing && !!comparison && comparisonLayout === "split") ||
                undefined
              }
            >
              {comparing && comparison && (
                <section
                  className="artifact-version"
                  hidden={
                    comparisonLayout === "switch" &&
                    visibleVersion !== "previous"
                  }
                >
                  <Text size="sm" fw={650}>
                    修正前 · 比較用に残した版
                  </Text>
                  <iframe
                    key={comparison}
                    title={`修正前の試作: ${selected}`}
                    className="artifact-frame"
                    sandbox="allow-scripts allow-pointer-lock"
                    referrerPolicy="no-referrer"
                    src={documentUrl(comparison)}
                  />
                </section>
              )}
              <section
                className="artifact-version"
                hidden={
                  comparing &&
                  !!comparison &&
                  comparisonLayout === "switch" &&
                  visibleVersion !== "current"
                }
              >
                {comparing && comparison && (
                  <Text size="sm" fw={650}>
                    いま開いている版
                  </Text>
                )}
                <iframe
                  key={`${currentVersion}:${refresh}`}
                  title={`試作: ${selected}`}
                  className="artifact-frame"
                  data-loading={!frameReady || undefined}
                  aria-busy={!frameReady}
                  onLoad={() => setFrameReady(true)}
                  sandbox="allow-scripts allow-pointer-lock"
                  referrerPolicy="no-referrer"
                  src={documentUrl(currentVersion)}
                />
              </section>
            </div>
          )}
          <Text size="xs" c="dimmed">
            開いた版をこの端末に残します。修正後は「修正前と比べる」で両方を操作できます。外部サービスが必要な作品は、環境のプレビューから開いてください。
          </Text>
          {canFollowup && (
            <Group className="artifact-feedback" align="end">
              <Textarea
                aria-label="試作への感想・修正依頼"
                label="触って気づいたことを、そのまま。"
                placeholder="例：移動が速すぎる。半分の速さにして比較したい。"
                value={feedback}
                onChange={(e) => setFeedback(e.currentTarget.value)}
                autosize
                minRows={2}
                maxRows={5}
                maxLength={8000}
              />
              <Button
                disabled={!feedback.trim() || sending}
                loading={sending}
                onClick={async () => {
                  setSending(true);
                  setNotice("");
                  try {
                    const accepted = await onFollowup(feedback.trim());
                    if (accepted) {
                      setRequestedAt(Date.now());
                      setFeedback("");
                      setNotice(
                        "修正依頼を受け付けました。できあがったら、ここで最新版を開けます。",
                      );
                    } else
                      setNotice(
                        "修正依頼を送れませんでした。会話画面の案内を確認してください。入力は残しています。",
                      );
                  } catch {
                    setNotice(
                      "修正依頼を送れませんでした。接続を確認して再度お試しください。",
                    );
                  } finally {
                    setSending(false);
                  }
                }}
              >
                このタスクに修正を依頼
              </Button>
            </Group>
          )}
          {notice && (
            <Text size="sm" role="status">
              {notice}
            </Text>
          )}
        </Stack>
      </Modal>
    </>
  );
}
