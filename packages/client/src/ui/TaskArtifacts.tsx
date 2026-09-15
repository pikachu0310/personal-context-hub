import {
  Alert,
  Button,
  Group,
  Modal,
  Select,
  Stack,
  Text,
  Textarea,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { api } from "./api.js";
import { Icon } from "./Icons.js";

type Artifact = { path: string; title?: string; updatedAt: number };

export function TaskArtifacts({
  runId,
  version,
  canFollowup,
  onFollowup,
}: {
  runId: string;
  version: string;
  canFollowup: boolean;
  onFollowup: (text: string) => Promise<boolean>;
}) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [html, setHtml] = useState<string>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [feedback, setFeedback] = useState("");
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState("");
  const [loadedAt, setLoadedAt] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
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
    void api<{ html: string; updatedAt: number }>(
      `artifacts?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(selected)}`,
    )
      .then((value) => {
        if (active) {
          setHtml(value.html);
          setLoadedAt(value.updatedAt);
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
        title="試して、その場で直す"
        size="calc(100vw - 3rem)"
        className="artifact-modal"
        transitionProps={{ duration: 0 }}
        centered
      >
        <Stack gap="md">
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
          </Group>
          {error && <Alert color="red">{error}</Alert>}
          {html === undefined ? (
            <Text role="status">{error ? "" : "試作を読み込んでいます…"}</Text>
          ) : (
            <iframe
              title={`試作: ${selected}`}
              className="artifact-frame"
              data-loading={!frameReady || undefined}
              aria-busy={!frameReady}
              onLoad={() => setFrameReady(true)}
              sandbox="allow-scripts allow-pointer-lock"
              referrerPolicy="no-referrer"
              src={`/api/artifact-document?runId=${encodeURIComponent(runId)}&path=${encodeURIComponent(selected ?? "")}&refresh=${refresh}`}
            />
          )}
          <Text size="xs" c="dimmed">
            単体のHTMLを表示しています。外部サービスへの接続が必要な作品は、環境のプレビューから開いてください。
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
