import { Button, Code, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { Card } from "../../../ui/src/components/Card.js";
import type { Action } from "../../../ui/src/types.js";
import { api } from "./api.js";
export function PairApproval({ action }: { action: Action }) {
  const [pair, setPair] = useState<{ name: string; fingerprint: string }>(),
    [message, setMessage] = useState("");
  const pairId = location.pathname.match(/^\/admin\/pair\/([\w-]+)$/)?.[1];
  useEffect(() => {
    if (pairId)
      void api<{ name: string; fingerprint: string }>("pair/" + pairId)
        .then(setPair)
        .catch((e) => setMessage(e.message));
  }, [pairId]);
  if (!pairId) return null;
  return (
    <Card
      title="この端末をチームに接続"
      description="自分のClient画面に出ている確認値と一致することを確認してください。"
    >
      {pair && (
        <>
          <Text>{pair.name}</Text>
          <Code block>{pair.fingerprint}</Code>
          <Button
            onClick={() =>
              void action("pair/approve", { id: pairId })
                .then(() => {
                  setPair(undefined);
                  history.replaceState(null, "", "/admin");
                  setMessage("承認しました。Clientの画面へ戻ってください。");
                })
                .catch((e) => setMessage(e.message))
            }
          >
            この端末を承認する
          </Button>
        </>
      )}
      {message && <Text>{message}</Text>}
    </Card>
  );
}
