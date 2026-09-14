import { TaskPriority } from "./TaskPriority.js";
import { TaskOwner } from "./TaskOwner.js";
import { Stack, Text } from "@mantine/core";
import { useState } from "react";
import type { Task } from "@ido/common/contracts/protocol";
import type { TeamTaskSnapshot, ClientState } from "@ido/common/contracts/api";
import { EnvironmentRow, TaskInspector } from "./TaskInspector.js";
import { stateLabel } from "./ActivityFeed.js";

export function SharedTaskInspector({
  task,
  summary,
  ownerName,
  registrationLabel,
  state,
}: {
  state: ClientState;
  task?: Task;
  summary?: TeamTaskSnapshot["tasks"][number];
  ownerName?: string;
  registrationLabel?: string;
}) {
  const [tab, setTab] = useState<string | null>("environment");
  const current = summary ?? task;
  return (
    <TaskInspector
      sourceTarget={
        current
          ? { taskId: current.id, projectId: current.projectId }
          : undefined
      }
      tab={tab}
      onTabChange={setTab}
      sources={task?.sourceStatements?.map((source, index) => ({
        id: `minutes-${index}`,
        kind: "minutes",
        title: source.speakerName
          ? `議事録 · ${source.speakerName}`
          : `議事録 ${index + 1}`,
        text: source.text,
        detail: [
          source.meetingId,
          source.sequence !== undefined ? `発言 ${source.sequence}` : undefined,
        ]
          .filter(Boolean)
          .join(" · "),
      }))}
      sourceNote="タスクに添付された共有ソースです。実行PCの個人情報は共有されません。"
    >
      <Stack gap="sm">
        <Text size="sm" c="dimmed">
          作業環境
        </Text>
        {registrationLabel && (
          <EnvironmentRow label="実行先">{registrationLabel}</EnvironmentRow>
        )}
        <EnvironmentRow label="実行PC">
          {summary?.deviceName ||
            (current?.clientId ? "端末名未取得" : "未割り当て")}
        </EnvironmentRow>
        <EnvironmentRow label="接続">
          {summary?.clientId
            ? summary.deviceConnected
              ? "接続中"
              : "オフライン"
            : "未取得"}
        </EnvironmentRow>
        <Text size="xs" c="dimmed">
          作業ブランチ・ディレクトリ・変更は、実行しているPCで確認できます。
        </Text>
      </Stack>
      <Stack gap="sm" className="inspector-section">
        <Text size="sm" c="dimmed">
          タスク
        </Text>
        <EnvironmentRow label="担当者">
          {current ? (
            <TaskOwner state={state} task={current} ownerName={ownerName} />
          ) : (
            "未割り当て"
          )}
        </EnvironmentRow>
        <EnvironmentRow label="状態">
          {current ? stateLabel(current.state) : "未取得"}
        </EnvironmentRow>
        {task && (
          <EnvironmentRow label="開始">
            {task.createdByBot
              ? "IDO Bot"
              : task.participants?.find((person) => person.id === task.authorId)
                  ?.name || "プロジェクトからの依頼"}
          </EnvironmentRow>
        )}
        <EnvironmentRow label="優先度">
          <TaskPriority priority={current?.priority} />
        </EnvironmentRow>
        <EnvironmentRow label="実行">{current?.revision}</EnvironmentRow>
        {current && (
          <EnvironmentRow label="最終更新">
            {new Date(current.updatedAt).toLocaleString()}
          </EnvironmentRow>
        )}
      </Stack>
    </TaskInspector>
  );
}
