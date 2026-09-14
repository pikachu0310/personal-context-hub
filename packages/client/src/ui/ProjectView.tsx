import { MeetingNotes } from "@ido/common-ui";
import { MinutesInspector } from "./MinutesInspector.js";
import { MinutesList } from "./MinutesList.js";
import type { TaskReference } from "@ido/common/contracts/api";
import { SharedTaskInspector } from "./SharedTaskInspector.js";
import {
  Alert,
  Badge,
  Button,
  Group,
  Paper,
  Modal,
  Tabs,
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
  const [projectDetails, setProjectDetails] = useState(false);
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
      <div
        className={
          task ? "project-document" : "project-document minutes-workspace"
        }
      >
        <Stack gap="sm">
          {error && <Alert color="red">{error}</Alert>}
          <Group justify="space-between">
            <Title order={2}>
              {task ? (task.title ?? task.text) : "議事録"}
            </Title>
            <Group gap="xs">
              <Text c="dimmed" size="sm">
                {state.project.name}
              </Text>
              {!task && (
                <Button
                  size="xs"
                  variant="subtle"
                  onClick={() => setProjectDetails(true)}
                >
                  プロジェクト詳細
                </Button>
              )}
            </Group>
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
                <MeetingNotes key={projectId} meetings={state.minutes} />
              </details>
            </Paper>
          ) : (
            <>
              <MinutesList
                key={projectId}
                meetings={state.minutes}
                projectId={projectId}
                projects={clientState.settings.projects.filter(
                  (p) =>
                    !clientState.allowedProjectIds ||
                    clientState.allowedProjectIds.includes(p.id),
                )}
                canEdit={clientState.connected && state.canEditMinutes === true}
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
              <Modal
                opened={projectDetails}
                onClose={() => setProjectDetails(false)}
                title="プロジェクト詳細"
                size="lg"
              >
                <Tabs defaultValue="notes">
                  <Tabs.List grow>
                    <Tabs.Tab value="notes">議題・発言</Tabs.Tab>
                    <Tabs.Tab value="members">参加者</Tabs.Tab>
                  </Tabs.List>
                  <Tabs.Panel value="notes" className="project-notes-modal">
                    <MinutesInspector
                      key={projectId}
                      meetings={state.minutes}
                    />
                  </Tabs.Panel>
                  <Tabs.Panel value="members" pt="sm">
                    <Stack gap="xs">
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
                                  ? (clientState.settings.profile?.name ??
                                    p.name)
                                  : p.name}
                                {self ? " · 自分" : ""}
                                {devices.some(
                                  (d) => d.id === state.project.ownerDeviceId,
                                )
                                  ? " · オーナー"
                                  : ""}
                              </Text>
                              <Badge color={p.codexConnected ? "teal" : "gray"}>
                                {p.codexConnected
                                  ? "Codex連携済み"
                                  : "Codex未連携"}
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
                  </Tabs.Panel>
                </Tabs>
              </Modal>
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
