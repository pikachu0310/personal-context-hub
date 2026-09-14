import { MinutesEditor } from "./MinutesEditor.js";
import { MeetingNotes } from "@ido/common-ui";
import type { TaskReference } from "@ido/common/contracts/api";
import { SharedTaskInspector } from "./SharedTaskInspector.js";
import {
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Stack,
  Text,
  Title,
} from "@mantine/core";
import { useEffect, useState } from "react";
import { TaskFollowup } from "./TaskFollowup.js";
import type { ProjectWorkspace } from "@ido/common/contracts/api";
import { TaskDispatchNotice } from "./TaskDispatchNotice.js";
import type { ClientState } from "@ido/common/contracts/api";
import { api } from "./api.js";
import { isSelf, participantGroups } from "./participant-identity.js";
export function ProjectView({
  projectId,
  taskId,
  deviceId,
  clientState,
  openSettings,
  openTask,
  dirtyChanged,
}: {
  projectId: string;
  taskId?: string;
  deviceId?: string;
  clientState: ClientState;
  openSettings: () => void;
  openTask: (reference: TaskReference) => void;
  dirtyChanged: (id: string, dirty: boolean) => void;
}) {
  const [state, setState] = useState<ProjectWorkspace>(),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const result = await api<ProjectWorkspace>("project/snapshot", {
          projectId,
        });
        if (active) {
          setState((current) => ({
            ...result,
            minutes: result.minutes.map((meeting) => {
              const previous = current?.minutes.find(
                (m) => m.id === meeting.id,
              );
              return previous &&
                (previous.summaryRevision ?? 0) > (meeting.summaryRevision ?? 0)
                ? previous
                : meeting;
            }),
          }));

          setError("");
        }
      } catch (e) {
        if (active) {
          setError((e as Error).message);
        }
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [projectId]);
  if (!state)
    return error ? (
      <Alert color="red">{error}</Alert>
    ) : (
      <Text p="xl">読み込み中…</Text>
    );
  const owner = state.project.ownerDeviceId === deviceId;
  const task = state.tasks.find(
    (t) => t.id === taskId && t.projectId === projectId,
  );
  if (taskId && !task)
    return (
      <Alert color="red">タスクは削除されたか、表示できなくなりました。</Alert>
    );
  return (
    <div className={task ? "task-workspace with-inspector" : "task-workspace"}>
      <div className="project-document">
        <Stack>
          {error && <Alert color="red">{error}</Alert>}
          <Group justify="space-between">
            <Title order={2}>
              {task ? (task.title ?? task.text) : "議事録"}
            </Title>
            <Text c="dimmed">{state.project.name}</Text>
          </Group>
          {task ? (
            <Paper p="lg" withBorder>
              <Text mt="md" style={{ whiteSpace: "pre-wrap" }}>
                {task.text}
              </Text>
              {task.result && (
                <Text mt="md" style={{ whiteSpace: "pre-wrap" }}>
                  {task.result}
                </Text>
              )}

              <TaskFollowup key={task.id} task={task} state={clientState} />
              {task.state === "queued" && !task.clientId && (
                <TaskDispatchNotice
                  state={clientState}
                  task={task}
                  openSettings={openSettings}
                />
              )}
              <details style={{ marginTop: 20 }}>
                <summary>会議の文脈・元の発言を確認</summary>
                <div style={{ marginTop: 16 }}>
                  <MeetingNotes key={projectId} meetings={state.minutes} />
                </div>
              </details>
            </Paper>
          ) : (
            <>
              <MeetingNotes
                key={projectId}
                meetings={state.minutes}
                document={
                  <>
                    {!state.minutes.length && (
                      <Text c="dimmed">
                        会話が始まると議事録が表示されます。
                      </Text>
                    )}
                    {state.minutes.map((m) => (
                      <MinutesEditor
                        key={m.id}
                        meeting={m}
                        projectId={projectId}
                        projects={clientState.settings.projects.filter(
                          (p) =>
                            !clientState.allowedProjectIds ||
                            clientState.allowedProjectIds.includes(p.id),
                        )}
                        canEdit={
                          clientState.connected && state.canEditMinutes === true
                        }
                        openTask={openTask}
                        dirtyChanged={dirtyChanged}
                        saved={(meeting) =>
                          setState(
                            (current) =>
                              current && {
                                ...current,
                                minutes: current.minutes.map((item) =>
                                  item.id === meeting.id &&
                                  (item.summaryRevision ?? 0) <=
                                    (meeting.summaryRevision ?? 0)
                                    ? meeting
                                    : item,
                                ),
                              },
                          )
                        }
                      />
                    ))}
                  </>
                }
              />
              <details>
                <summary>詳細を見る</summary>
                <Stack mt="md">
                  <Title order={3}>参加しているユーザー</Title>
                  {participantGroups(state.participants).map((devices) => {
                    const p =
                      devices.find((d) => d.id === deviceId) ?? devices[0];
                    const self = isSelf(p, clientState.settings);
                    return (
                      <Paper key={p.identityId ?? p.id} p="md" withBorder>
                        <Group justify="space-between">
                          <Text fw={600}>
                            {self
                              ? (clientState.settings.profile?.name ?? p.name)
                              : p.name}
                            {self ? " · 自分" : ""}
                            {devices.some(
                              (d) => d.id === state.project.ownerDeviceId,
                            )
                              ? " · オーナー"
                              : ""}
                          </Text>
                          <Badge color={p.codexConnected ? "teal" : "gray"}>
                            {p.codexConnected ? "Codex連携済み" : "Codex未連携"}
                          </Badge>
                        </Group>
                        <Text mt="sm" style={{ whiteSpace: "pre-wrap" }}>
                          {p.context || "個人コンテキストは未設定です。"}
                        </Text>
                        {owner &&
                          devices
                            .filter((d) => d.id !== deviceId)
                            .map((d) => (
                              <Button
                                key={d.id}
                                mt="sm"
                                color="red"
                                variant="subtle"
                                onClick={async () => {
                                  try {
                                    await api("project/remove-member", {
                                      projectId,
                                      deviceId: d.id,
                                    });
                                    setState(
                                      await api("project/snapshot", {
                                        projectId,
                                      }),
                                    );
                                  } catch (e) {
                                    setError((e as Error).message);
                                  }
                                }}
                              >
                                プロジェクトから削除
                                {devices.length > 1 ? ` · ${d.id}` : ""}
                              </Button>
                            ))}
                      </Paper>
                    );
                  })}
                </Stack>
              </details>
            </>
          )}
        </Stack>
      </div>
      {task && (
        <SharedTaskInspector
          state={clientState}
          key={task.id}
          task={task}
          summary={clientState.teamTasks?.tasks.find(
            (item) => item.id === task.id,
          )}
          ownerName={
            state.participants.find((person) => person.id === task.clientId)
              ?.name
          }
        />
      )}
    </div>
  );
}
