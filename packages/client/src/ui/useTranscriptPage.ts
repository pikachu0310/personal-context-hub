import { useEffect, useRef, useState } from "react";
import type {
  TranscriptPage,
  TranscriptQuery,
} from "@ido/common/contracts/api";

export function useTranscriptPage(
  load: ((query: TranscriptQuery) => Promise<TranscriptPage>) | undefined,
  query: TranscriptQuery,
  version: string,
  enabled: boolean,
) {
  const [page, setPage] = useState<TranscriptPage>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const epoch = useRef(0);
  const key = JSON.stringify(query);
  useEffect(() => {
    const request = ++epoch.current;
    if (!load || !enabled) return;
    setPage(undefined);
    setError("");
    setLoading(true);
    const timer = setTimeout(() => {
      void load(JSON.parse(key))
        .then((result) => {
          if (request === epoch.current) setPage(result);
        })
        .catch(() => {
          if (request === epoch.current)
            setError("発言を取得できませんでした。もう一度お試しください。");
        })
        .finally(() => {
          if (request === epoch.current) setLoading(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      epoch.current++;
    };
  }, [load, key, version, enabled, retry]);
  async function more() {
    if (!load || !page?.next || loading) return;
    const request = epoch.current;
    setLoading(true);
    setError("");
    try {
      const result = await load({ ...query, before: page.next });
      if (request !== epoch.current) return;
      setPage((previous) => ({
        ...result,
        messages: [
          ...new Map(
            [...(previous?.messages ?? []), ...result.messages].map((m) => [
              m.id,
              m,
            ]),
          ).values(),
        ],
      }));
    } catch {
      if (request === epoch.current)
        setError("以前の発言を取得できませんでした。もう一度お試しください。");
    } finally {
      if (request === epoch.current) setLoading(false);
    }
  }
  return { page, loading, error, more, retry: () => setRetry((v) => v + 1) };
}
