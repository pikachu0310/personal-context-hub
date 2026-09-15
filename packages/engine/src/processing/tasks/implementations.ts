import { createHash } from "node:crypto";
import {
  implementationRemote,
  previewReference,
  type Implementation,
  type ImplementationAvailability,
  type ImplementationChoice,
} from "@ido/common/contracts/api";
import { id, text, type Task } from "@ido/common/contracts/protocol";
import type { Repository } from "../../ports/repository.js";
import { ProjectTeam } from "../projects/team.js";

interface Availability {
  taskId: string;
  runId: string;
  revision: number;
  availability: ImplementationAvailability;
  implementationId?: string;
}
export class Implementations {
  constructor(readonly store: Repository) {}
  sync(deviceId: string, input: Record<string, unknown>) {
    const task = this.store.get<Task>("task", id(input.taskId));
    if (!task) throw new Error("TASK_NOT_FOUND");
    new ProjectTeam(this.store).require(deviceId, task.projectId);
    if (
      task.clientId !== deviceId ||
      task.runId !== input.runId ||
      task.revision !== input.revision
    )
      throw new Error("TASK_ASSIGNMENT_CHANGED");
    if (
      !["ready", "uncommitted", "unpushed", "unavailable"].includes(
        String(input.availability),
      )
    )
      throw new Error("INVALID_IMPLEMENTATION");
    const status: Availability = {
      taskId: task.id,
      runId: task.runId,
      revision: task.revision,
      availability: input.availability as ImplementationAvailability,
    };
    if (status.availability === "ready") {
      if (
        task.state !== "completed" ||
        typeof input.commit !== "string" ||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit)
      )
        throw new Error("INVALID_IMPLEMENTATION");
      const remote = implementationRemote(input.remote),
        branch = text(input.branch, 300);
      if (
        !/^refs\/(heads|tags)\//.test(branch) ||
        /[\s~^:?*\[\\]|\.\.|@\{/.test(branch)
      )
        throw new Error("INVALID_IMPLEMENTATION");
      const identity = [
        task.projectId,
        task.id,
        task.runId,
        task.revision,
        remote,
        branch,
        input.commit,
      ];
      const key = createHash("sha256")
        .update(JSON.stringify(identity))
        .digest("hex");
      const artifact: Implementation = {
        id: key,
        projectId: task.projectId,
        taskId: task.id,
        runId: task.runId,
        revision: task.revision,
        title: task.title ?? task.text.slice(0, 90),
        remote,
        branch,
        commit: input.commit,
        createdAt: Date.now(),
      };
      if (!this.store.get("implementation", key))
        this.store.put("implementation", key, artifact);
      status.implementationId = key;
    }
    const previous = this.store.get<Availability>(
      "implementation-status",
      task.id,
    );
    const changed = JSON.stringify(previous) !== JSON.stringify(status);
    if (changed) this.store.put("implementation-status", task.id, status);
    return { changed, meetingId: task.meetingId };
  }
  choices(projectId: string, meetingId?: string): ImplementationChoice[] {
    return this.store
      .list<Task>("task")
      .filter(
        (t) =>
          t.projectId === projectId &&
          (!meetingId || t.meetingId === meetingId),
      )
      .map((task) => {
        const saved = this.store.get<Availability>(
          "implementation-status",
          task.id,
        );
        const current =
          !!saved &&
          saved.runId === task.runId &&
          saved.revision === task.revision &&
          task.state === "completed";
        return {
          taskId: task.id,
          title: task.title ?? task.text.slice(0, 90),
          availability: current ? saved.availability : "unavailable",
          implementation:
            current && saved.implementationId
              ? this.store.get<Implementation>(
                  "implementation",
                  saved.implementationId,
                )
              : undefined,
        };
      });
  }
  read(deviceId: string, input: unknown): Implementation[] {
    const reference = previewReference(input);
    new ProjectTeam(this.store).require(deviceId, reference.projectId);
    return reference.implementationIds.map((key) =>
      this.resolve(reference.projectId, key),
    );
  }
  resolve(projectId: string, key: string): Implementation {
    const result = this.store.get<Implementation>("implementation", key);
    const task = result && this.store.get<Task>("task", result.taskId);
    if (
      !result ||
      !task ||
      task.projectId !== projectId ||
      result.projectId !== projectId
    )
      throw new Error("IMPLEMENTATION_NOT_FOUND");
    return result;
  }
}
