import { Alert, Button, Text } from "@mantine/core";
import type { ClientState } from "@ido/common/contracts/api";
import { taskReadiness } from "./task-readiness.js";
export function TaskDispatchNotice({
  state,
  task,
  openSettings,
  waiting = true,
}: {
  state: ClientState;
  task: { projectId: string; network?: boolean };
  openSettings: () => void;
  waiting?: boolean;
}) {
  const readiness = taskReadiness(state, task);
  if (!waiting && readiness.reason === "ready") return null;
  return (
    <Alert
      mt="md"
      color={readiness.reason === "ready" ? "blue" : "yellow"}
      title={
        readiness.reason === "ready"
          ? "割り当て待ち"
          : "このClientで実行できない理由"
      }
    >
      <Text size="sm">{readiness.text}</Text>
      {["directory", "permission", "network", "capacity"].includes(
        readiness.reason,
      ) && (
        <Button mt="sm" variant="light" onClick={openSettings}>
          プロジェクトの接続・設定を開く
        </Button>
      )}
    </Alert>
  );
}
