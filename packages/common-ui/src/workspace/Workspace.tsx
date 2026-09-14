import { Modal, Paper, SimpleGrid, Text } from "@mantine/core";
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
  const [page, setPage] = useState("overview"),
    [preview, setPreview] = useState("");
  const showPreview = (taskId: string) => {
    void action("preview", { taskId }).then((result) =>
      setPreview(result.url ?? ""),
    );
  };
  const props = {
    state,
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
    ["meetings", "会議"],
    ["minutes", "議事録"],
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
