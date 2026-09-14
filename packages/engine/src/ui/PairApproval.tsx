import { Button, Code, Select, Text } from "@mantine/core";
import { useEffect, useState } from "react";
import { Card } from "@ido/common-ui";
import type { Action } from "@ido/common-ui";
import { api } from "./api.js";
export function PairApproval({ action }: { action: Action }) {
  const [pair, setPair] = useState<{
      name: string;
      fingerprint: string;
      candidates?: Array<{ id: string; name: string }>;
    }>(),
    [deviceId, setDeviceId] = useState<string | null>(null),
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
          {(pair.candidates?.length ?? 0) > 1 && (
            <Select
              label="復元する既存の端末登録"
              placeholder="過去に使っていた端末IDを選択"
              value={deviceId}
              onChange={setDeviceId}
              data={pair.candidates!.map((d) => ({
                value: d.id,
                label: `${d.name} · ${d.id}`,
              }))}
            />
          )}
          {pair.candidates?.length === 1 && (
            <Text size="sm">
              既存の端末ID {pair.candidates[0].id} を引き継ぎます。
            </Text>
          )}
          <Button
            disabled={(pair.candidates?.length ?? 0) > 1 && !deviceId}
            onClick={() =>
              void action("pair/approve", {
                id: pairId,
                ...(deviceId ? { deviceId } : {}),
              })
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
