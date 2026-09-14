import { Modal, Select, Paper, SimpleGrid, Text } from "@mantine/core";
import { useState } from "react";
import { Shell } from "../components/Shell.js";
import type { Action, Invoke, WorkspaceState } from "../types.js";
import { Artifacts } from "./Artifacts.js";
import { Meetings } from "./Meetings.js";
import { Minutes } from "./Minutes.js";
import { Projects } from "./Projects.js";
import { TaskList } from "./TaskList.js";
import { Tasks } from "./Tasks.js";
export function Workspace({
  state,
  action,
  invoke,
  refresh,
  error,
  activity = false,
}: {
  state: WorkspaceState;
  action: Action;
  invoke: Invoke;
  refresh: () => void;
  error: string;
  activity?: boolean;
}) {
  const [page, setPage] = useState("meetings"),
    [preview, setPreview] = useState("");
  const [selectedProject, selectProject] = useState("");
  const projectId = state.projects.some((p) => p.id === selectedProject)
    ? selectedProject
    : (state.projects.find((p) => p.isDefault)?.id ?? state.projects[0]?.id);
  const showPreview = (taskId: string) => {
    void action("preview", { taskId }).then((result) =>
      setPreview(result.url ?? ""),
    );
  };
  const props = {
    state,
    projectId,
    action,
    invoke,
    showPreview,
    readonly: state.user.role === "viewer",
    activity,
    page,
    setPage,
  };
  const pages = [
    ["overview", "チームの状況"],
    ["meetings", "会話"],
    ["minutes", "過去の議事録"],
    ...(!activity ? [["projects", "プロジェクト"]] : []),
    ["tasks", "タスク"],
    ["artifacts", "成果物"],
  ];
  return (
    <>
      <Shell
        title={activity ? "ACTIVITY" : "DASHBOARD"}
        pages={pages}
        page={page}
        select={setPage}
        refresh={refresh}
        error={error}
      >
        <Select
          mb="md"
          label="現在のプロジェクト"
          searchable
          allowDeselect={false}
          value={projectId ?? null}
          data={state.projects.map((p) => ({ value: p.id, label: p.name }))}
          onChange={(v) => selectProject(v ?? "")}
        />
        {page === "overview" && (
          <>
            <SimpleGrid cols={{ base: 1, sm: 3 }} mb="xl">
              {[
                ["会議", state.meetings.length],
                ["プロジェクト", state.projects.length],
                ["タスク", state.tasks.length],
              ].map(([label, value]) => (
                <Paper withBorder p="lg" key={label}>
                  <Text>{label}</Text>
                  <Text size="xl">{value}</Text>
                </Paper>
              ))}
            </SimpleGrid>
            <TaskList
              tasks={state.tasks}
              projects={state.projects}
              control={invoke}
              preview={showPreview}
              readonly={props.readonly}
              activity={activity}
              action={action}
            />
          </>
        )}
        <Meetings {...props} />
        <Minutes {...props} />
        <Artifacts {...props} />
        <Projects {...props} />
        <Tasks {...props} />
      </Shell>
      <Modal
        opened={!!preview}
        onClose={() => setPreview("")}
        title="実行版プレビュー"
        size="95%"
      >
        <iframe
          title="タスクのプレビュー"
          src={preview}
          sandbox="allow-scripts allow-forms"
          referrerPolicy="no-referrer"
          className="preview"
        />
      </Modal>
    </>
  );
}
