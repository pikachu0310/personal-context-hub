import { Alert, Loader } from "@mantine/core";
import { useState } from "react";
import { Shell } from "@ido/common-ui";
import "@ido/common-ui/style.css";
import { ClientView } from "./ClientView.js";
import { useRemoteState } from "./useRemoteState.js";
export function App() {
  const { state, error, refresh, action, invoke } = useRemoteState();
  const [page, setPage] = useState("overview");
  if (!state) return error ? <Alert color="red">{error}</Alert> : <Loader />;
  return (
    <Shell
      title="IDO Agent"
      workspaceLinks={false}
      pages={[
        ["overview", "接続とセットアップ"],
        ["runs", "実行と承認"],
      ]}
      page={page}
      select={setPage}
      refresh={() => void refresh()}
      error={error}
    >
      <ClientView page={page} state={state} action={action} invoke={invoke} />
    </Shell>
  );
}
