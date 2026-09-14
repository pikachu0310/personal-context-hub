import { useCallback, useEffect, useState } from "react";
import type { ApiResult, ClientState } from "@ido/common-ui";
import { api } from "./api.js";
export function useRemoteState() {
  const [state, setState] = useState<ClientState>(),
    [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setState(await api<ClientState>("state"));
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  }, []);
  useEffect(() => {
    let disposed = false;
    const poll = () => {
      if (!disposed) void refresh();
    };
    poll();
    const timer = setInterval(poll, 2500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [refresh]);
  const action = async (path: string, input: Record<string, unknown>) => {
    const result = await api<ApiResult>(path, input);
    await refresh();
    return result;
  };
  const invoke = (path: string, input: Record<string, unknown>) => {
    void action(path, input).catch((error) => setError(error.message));
  };
  return { state, error, refresh, action, invoke };
}
