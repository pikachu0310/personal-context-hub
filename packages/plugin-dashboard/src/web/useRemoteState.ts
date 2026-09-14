import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardState } from "@ido/common/contracts/api";
export function useRemoteState(projectId: string) {
  const [state, setState] = useState<DashboardState>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState("");
  const [now, setNow] = useState(Date.now());
  const generation = useRef(0),
    controller = useRef<AbortController | undefined>(undefined);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    const timeout = setTimeout(() => request.abort(), 8000);
    setLoading(true);
    try {
      const response = await fetch(
        "/api/admin/dashboard" +
          (projectId ? `?projectId=${encodeURIComponent(projectId)}` : ""),
        { cache: "no-store", signal: request.signal },
      );
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "REQUEST_FAILED");
      if (current !== generation.current) return;
      setState(value);
      setScope(projectId);
      setError("");
    } catch (e) {
      if (current === generation.current) {
        const reason = (e as Error).message;
        if (["LOGIN_REQUIRED", "PERMISSION_DENIED"].includes(reason))
          setState(undefined);
        setError(reason);
      }
    } finally {
      clearTimeout(timeout);
      if (current === generation.current) {
        setLoading(false);
        controller.current = undefined;
      }
    }
  }, [projectId]);
  useEffect(() => {
    void refresh();
    const poll = setInterval(() => {
      if (!controller.current) void refresh();
    }, 2500);
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      generation.current++;
      controller.current?.abort();
      controller.current = undefined;
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [refresh]);
  return {
    state,
    error,
    loading,
    refresh,
    now,
    stale:
      !!error || !state || now - state.updatedAt > 10000 || scope !== projectId,
  };
}
