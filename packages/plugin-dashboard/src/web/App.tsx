import { Alert, Anchor, Loader } from "@mantine/core";
import "../../../ui/src/style.css";
import { Workspace } from "../../../ui/src/workspace/Workspace.js";
import { useRemoteState } from "./useRemoteState.js";
export function App() {
  const { state, error, refresh, action, invoke } = useRemoteState();
  if (!state)
    return error ? (
      <Alert color="red">
        {error}
        <Anchor href="/admin">Engine管理画面でログイン</Anchor>
      </Alert>
    ) : (
      <Loader />
    );
  return (
    <Workspace
      state={state}
      error={error}
      refresh={() => void refresh()}
      action={action}
      invoke={invoke}
    />
  );
}
