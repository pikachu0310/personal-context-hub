import { createHash } from "node:crypto";
import type { Repository } from "../../ports/repository.js";
import type { Task } from "@ido/common/contracts/protocol";
import { projectDiscussion } from "./board.js";

// Remember only projects deliberately exposed to this exact Discord destination.
export function forumProjects(
  store: Repository,
  pluginId: string,
  config: Record<string, string>,
  register = false,
) {
  if (!config.guildId || !config.issueForumChannelId || !config.projectId)
    return [];
  const key = JSON.stringify([
    pluginId,
    config.guildId,
    config.issueForumChannelId,
  ]);
  const projects = store.get<string[]>("forum-projects", key) ?? [];
  if (register && !projects.includes(config.projectId)) {
    projects.push(config.projectId);
    store.put("forum-projects", key, projects);
  }
  return projects.filter((projectId) => !!store.get("project", projectId));
}

export function boundForumTask(
  store: Repository,
  pluginId: string,
  config: Record<string, string>,
  taskId: unknown,
  channelId: unknown,
) {
  if (typeof taskId !== "string" || typeof channelId !== "string") return;
  const projects = forumProjects(store, pluginId, config);
  const task =
    store.get<Task>("task", taskId) ??
    projects.map(projectDiscussion).find((task) => task.id === taskId);
  if (!task || !forumProjects(store, pluginId, config).includes(task.projectId))
    return;
  const key =
    "forum-" +
    createHash("sha256")
      .update(
        JSON.stringify([
          config.guildId,
          config.issueForumChannelId,
          task.projectId,
        ]),
      )
      .digest("hex");
  const records = store.get<Array<{ taskId: string; threadId?: string }>>(
    `plugin:${pluginId}`,
    key,
  );
  return records?.some(
    (record) => record.taskId === task.id && record.threadId === channelId,
  )
    ? task
    : undefined;
}
