import type { CoordinatorEvent } from "@ido/common/contracts/coordinator";
import {
  type Project,
  type Task,
  type User,
} from "@ido/common/contracts/protocol";
import type { Repository } from "../../ports/repository.js";
import type { Device, Meeting } from "../../domain/models.js";
import { ProjectTeam } from "./team.js";
import type { BoardThread } from "../tasks/board.js";
import {
  participantId,
  seedParticipants,
  taskBusy,
  taskParticipants,
} from "./task-participants.js";

export type LifecycleActor =
  { deviceId: string; valid(): boolean } | { user: User; valid(): boolean };
export type Deletion = {
  taskId: string;
  projectId: string;
  pendingDeviceIds: string[];
};
export class WorkspaceLifecycle {
  constructor(
    readonly store: Repository,
    readonly reset: (
      projectId: string,
      taskIds: string[],
    ) => Promise<void> = async () => {},
    readonly invalidate: (task: Task) => void = () => {},
  ) {}
  authorize(actor: LifecycleActor, projectId: string) {
    if (!actor.valid()) throw new Error("PERMISSION_DENIED");
    if ("deviceId" in actor)
      new ProjectTeam(this.store).require(actor.deviceId, projectId);
    else if (
      !this.store.user(actor.user.id) ||
      this.store.user(actor.user.id)?.role === "viewer"
    )
      throw new Error("PERMISSION_DENIED");
  }
  canDelete(actor: LifecycleActor, task: Task) {
    const project = this.store.get<Project>("project", task.projectId);
    if ("deviceId" in actor)
      return (
        task.authorId === `client-${actor.deviceId}` ||
        project?.ownerDeviceId === actor.deviceId
      );
    return (
      this.store.user(actor.user.id)?.role === "admin" ||
      task.authorId === actor.user.id ||
      (!!project?.ownerDeviceId &&
        this.store.get<Device>("device", project.ownerDeviceId)?.userId ===
          actor.user.id)
    );
  }
  membership(
    actor: LifecycleActor,
    taskId: string,
    joined: boolean,
    version: unknown,
  ) {
    return this.store.transaction(() => {
      const task = this.store.get<Task>("task", taskId);
      if (!task) throw new Error("TASK_NOT_FOUND");
      this.authorize(actor, task.projectId);
      if (this.store.get("project-lock", task.projectId))
        throw new Error("WORKSPACE_CONFLICT");
      seedParticipants(this.store, task);
      if (version !== (task.membershipVersion ?? 0))
        throw new Error("WORKSPACE_CONFLICT");
      const actorId =
        "deviceId" in actor ? actor.deviceId : participantId(actor.user.id);
      task.memberStates![actorId] = joined;
      task.membershipVersion = (task.membershipVersion ?? 0) + 1;
      this.store.put("task", taskId, task);
      return {
        ...task,
        participants: taskParticipants(this.store, task),
        canDelete: this.canDelete(actor, task),
      };
    });
  }
  async deleteTask(
    actor: LifecycleActor,
    taskId: string,
    input: Record<string, unknown>,
  ) {
    const check = () => {
      const task = this.store.get<Task>("task", taskId);
      if (!task) throw new Error("TASK_NOT_FOUND");
      this.authorize(actor, task.projectId);
      if (!this.canDelete(actor, task)) throw new Error("PERMISSION_DENIED");
      if (
        input.force === true &&
        (!("user" in actor) || this.store.user(actor.user.id)?.role !== "admin")
      )
        throw new Error("PERMISSION_DENIED");
      if (input.confirm !== true)
        throw new Error("DELETE_CONFIRMATION_REQUIRED");
      if (
        input.revision !== task.revision ||
        input.controlVersion !== (task.controlVersion ?? 0) ||
        input.membershipVersion !== (task.membershipVersion ?? 0)
      )
        throw new Error("WORKSPACE_CONFLICT");
      if (input.force !== true && taskBusy(task))
        throw new Error("TASK_ACTIVE");
      return task;
    };
    const task = check();
    await this.withReset(task.projectId, [task.id], () => {
      const current = check();
      this.purgeTask(current);
      this.purgeTaskContext(current.projectId, [current.id]);
    });
    return {
      ok: true,
      pendingClients: this.store.get<Deletion>("task-deletion", taskId)!
        .pendingDeviceIds.length,
    };
  }
  async deleteProject(
    actor: LifecycleActor,
    projectId: string,
    input: Record<string, unknown>,
  ) {
    const check = () => {
      if (
        !("user" in actor) ||
        !actor.valid() ||
        this.store.user(actor.user.id)?.role !== "admin"
      )
        throw new Error("PERMISSION_DENIED");
      const project = this.store.get<Project>("project", projectId);
      if (!project) throw new Error("PROJECT_NOT_FOUND");
      if (project.isDefault || project.id === "default")
        throw new Error("DEFAULT_PROJECT_DELETE_FORBIDDEN");
      if (input.name !== project.name || input.confirm !== true)
        throw new Error("DELETE_CONFIRMATION_REQUIRED");
      if (input.membershipVersion !== (project.membershipVersion ?? 0))
        throw new Error("WORKSPACE_CONFLICT");
      const tasks = this.store
        .list<Task>("task")
        .filter((t) => t.projectId === projectId);
      if (input.force !== true && tasks.some(taskBusy))
        throw new Error("PROJECT_TASKS_ACTIVE");
      return tasks;
    };
    const tasks = check();
    await this.withReset(
      projectId,
      tasks.map((t) => t.id),
      () => {
        const current = check();
        for (const task of current) this.purgeTask(task);
        const meetings = this.store
          .list<Meeting>("meeting")
          .filter((m) => m.projectId === projectId);
        const ids = new Set([
          projectId,
          ...meetings.map((m) => m.id),
          ...meetings.flatMap((m) => m.messages.map((v) => v.id)),
        ]);
        const entries = this.store.entries();
        // Propagate only explicit ownership links, never inspect arbitrary user text.
        const owned = (entry: (typeof entries)[number]) =>
          ids.has(entry.id) ||
          entry.value?.projectId === projectId ||
          ids.has(entry.value?.meetingId) ||
          ids.has(entry.value?.messageId) ||
          [...ids].some((id) => entry.id.startsWith(`${id}:`));
        for (const entry of entries)
          if (owned(entry) && ["input", "message"].includes(entry.kind))
            ids.add(entry.id);
        for (const entry of entries) {
          if (entry.kind.endsWith("-deletion")) continue;
          if (
            entry.kind === "project-create" &&
            entry.value?.projectId === projectId
          ) {
            this.store.put(entry.kind, entry.id, { projectId });
          } else if (
            owned(entry) &&
            [
              "project",
              "meeting",
              "message",
              "input",
              "project-member",
              "project-invite",
              "project-removal",
              "project-exit",
              "project-conversation",
              "conversation-route",
              "voice-route",
              "utterance-route",
              "conversation-output",
              "coordinator",
              "coordinator-source-route",
              "speech-assembly",
              "speech-sources",
              "project-context",
            ].includes(entry.kind)
          )
            this.store.remove(entry.kind, entry.id);
        }
        for (const meeting of meetings)
          this.store.put("meeting-deletion", meeting.id, {});
        for (const device of this.store.list<Device>("device")) {
          device.grants = device.grants.filter(
            (g) => g.projectId !== projectId,
          );
          this.store.put("device", device.id, device);
        }
        this.store.put("project-deletion", projectId, {});
      },
    );
    return {
      ok: true,
      pendingClients: this.store
        .list<Deletion>("task-deletion")
        .filter((d) => d.projectId === projectId)
        .reduce((n, d) => n + d.pendingDeviceIds.length, 0),
    };
  }
  private async withReset(
    projectId: string,
    taskIds: string[],
    commit: () => void,
  ) {
    if (this.store.get("project-lock", projectId))
      throw new Error("WORKSPACE_CONFLICT");
    this.store.put("project-lock", projectId, {});
    this.store.put("project-context", projectId, {
      cutoffAt: Date.now(),
      revision:
        (this.store.get<{ revision: number }>("project-context", projectId)
          ?.revision ?? 0) + 1,
    });
    try {
      await this.reset(projectId, taskIds);
      this.resetSavedContext(projectId, taskIds);
      this.store.transaction(() => {
        this.store.remove("project-lock", projectId);
        commit();
      });
    } finally {
      this.store.remove("project-lock", projectId);
    }
  }
  private resetSavedContext(projectId: string, taskIds: string[]) {
    for (const meeting of this.store
      .list<Meeting>("meeting")
      .filter((m) => m.projectId === projectId)) {
      const saved = this.store.get<{ inbox?: any; completed?: string[] }>(
        "coordinator",
        meeting.id,
      );
      if (!saved) continue;
      const inbox = saved.inbox ?? {};
      const keep = (event: CoordinatorEvent) =>
        event.type !== "assistant_output" &&
        (event.type !== "task_result" || !taskIds.includes(event.taskId));
      const pending = (inbox.pending ?? []).filter(keep);
      const events = [
        ...(inbox.active?.events ?? []),
        ...(inbox.active?.steering ?? []),
      ].filter(keep);
      const active = events.length
        ? { id: inbox.active.id, status: "uncertain", events }
        : undefined;
      // This also runs in legacy/disabled AI mode, before a later model can resume.
      this.store.put("coordinator", meeting.id, {
        ...saved,
        inbox: { pending, active, receipts: inbox.receipts ?? [] },
        completed: (saved.completed ?? []).filter(
          (id) => !taskIds.some((taskId) => id.includes(taskId)),
        ),
      });
    }
  }
  private purgeTask(task: Task) {
    this.store.remove("task-board", task.id);
    for (const thread of this.store.list<BoardThread>("task-board")) {
      const retained = thread.posts.filter(
        (post) => post.authorTaskId !== task.id,
      );
      if (retained.length !== thread.posts.length)
        this.store.put("task-board", thread.taskId, {
          ...thread,
          posts: retained,
        });
    }
    this.invalidate(task);
    const devices = this.store.list<Device>("device");
    const pendingDeviceIds: string[] = [];
    for (const device of devices) {
      for (const command of this.store.pending(device.id)) {
        if (
          command.taskId === task.id ||
          (command.task as Task | undefined)?.id === task.id
        )
          this.store.ack(device.id, command.id!);
      }
      // Every approved Client may have cached this task while it was a member.
      if (!device.revoked) {
        pendingDeviceIds.push(device.id);
        this.store.enqueue(device.id, { type: "task.purge", taskId: task.id });
      }
    }
    for (const entry of this.store.entries())
      if (entry.kind === "task-control" && entry.value?.taskId === task.id)
        this.store.remove(entry.kind, entry.id);
    this.store.remove("task", task.id);
    this.store.put("task-deletion", task.id, {
      taskId: task.id,
      projectId: task.projectId,
      pendingDeviceIds,
    } satisfies Deletion);
  }
  private purgeTaskContext(projectId: string, taskIds: string[]) {
    const meetings = this.store
      .list<Meeting>("meeting")
      .filter((m) => m.projectId === projectId);
    const meetingIds = new Set(meetings.map((m) => m.id));
    for (const entry of this.store.entries()) {
      if (
        entry.kind !== "conversation-output" ||
        !meetingIds.has(entry.value?.meetingId) ||
        !entry.value?.taskIds?.some((id: string) => taskIds.includes(id))
      )
        continue;
      for (const sourceId of entry.value.sourceIds ?? []) {
        const message = this.store.get<any>("message", sourceId);
        if (message && message.replyText === entry.value.text) {
          delete message.replyText;
          this.store.put("message", sourceId, message);
        }
      }
      this.store.remove(entry.kind, entry.id);
    }
  }
  acknowledge(deviceId: string, commandId: string) {
    const command = this.store
      .pending(deviceId)
      .find((c) => c.id === commandId && c.type === "task.purge");
    if (command?.taskId) {
      if (this.store.get<Device>("device", deviceId)?.lifecycleVersion !== 1)
        return;
      const deletion = this.store.get<Deletion>(
        "task-deletion",
        command.taskId,
      );
      if (deletion) {
        deletion.pendingDeviceIds = deletion.pendingDeviceIds.filter(
          (id) => id !== deviceId,
        );
        this.store.put("task-deletion", command.taskId, deletion);
      }
    }
    this.store.ack(deviceId, commandId);
  }
}
