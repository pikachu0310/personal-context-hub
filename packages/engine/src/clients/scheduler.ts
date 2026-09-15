import {
  canSchedule,
  schedulingPriority,
} from "../processing/tasks/priority.js";
import {
  addParticipant,
  taskParticipants,
} from "../processing/projects/task-participants.js";
import type { Task } from "@ido/common/contracts/protocol";
import type { Device } from "../domain/models.js";
import type { Repository } from "../ports/repository.js";
import {
  requiresPolicySupport,
  restrictExecutionPolicy,
} from "@ido/common/contracts/work";
export function supportsTask(device: Device, task: Task) {
  if (
    (task.model ||
      task.reasoningEffort ||
      task.progressMode ||
      task.agent === "claude") &&
    device.profile?.taskOptionsVersion !== 1
  )
    return false;
  return task.agent === "claude"
    ? device.profile?.claudeConnected === true &&
        device.grants.some(
          (g) => g.projectId === task.projectId && g.agents?.includes("claude"),
        )
    : task.agent === "codex"
      ? device.codexConnected === true
      : device.codexConnected === true ||
        (device.profile?.taskOptionsVersion === 1 &&
          device.profile?.claudeConnected === true &&
          device.grants.some(
            (g) =>
              g.projectId === task.projectId && g.agents?.includes("claude"),
          ));
}
export class Scheduler {
  constructor(readonly repository: Repository) {}
  schedule(online: Set<string>) {
    return this.repository.transaction(() => {
      const tasks = this.repository.list<Task>("task");
      const devices = this.repository
        .list<Device>("device")
        .filter((d) => online.has(d.id) && !d.revoked);
      for (const task of tasks
        .filter(
          (t) =>
            t.state === "queued" &&
            canSchedule(t) &&
            !t.clientId &&
            !t.localMirror &&
            !this.repository.get("project-lock", t.projectId),
        )
        .sort(
          (a, b) =>
            schedulingPriority(b) - schedulingPriority(a) ||
            a.createdAt - b.createdAt ||
            a.id.localeCompare(b.id),
        )) {
        const active = (device: Device) =>
          tasks.filter(
            (t) =>
              t.clientId === device.id &&
              ["assigned", "running", "interrupted"].includes(t.state),
          ).length;
        const eligible = devices.filter(
          (d) =>
            supportsTask(d, task) &&
            (!requiresPolicySupport(
              restrictExecutionPolicy(
                task.executionPolicy,
                task.effectiveExecutionPolicy,
              ),
            ) ||
              d.executionPolicyVersion === 1) &&
            d.slots > active(d) &&
            d.grants.some(
              (g) =>
                g.projectId === task.projectId &&
                (!task.network || g.network) &&
                tasks.filter(
                  (t) =>
                    t.clientId === d.id &&
                    t.projectId === g.projectId &&
                    ["assigned", "running", "interrupted"].includes(t.state),
                ).length < g.slots,
            ),
        );
        eligible.sort(
          (a, b) =>
            b.slots - active(b) - (a.slots - active(a)) ||
            a.lastAssigned - b.lastAssigned ||
            a.id.localeCompare(b.id),
        );
        const device = eligible[0];
        if (!device) continue;
        task.agent ??= device.codexConnected ? "codex" : "claude";
        addParticipant(this.repository, task, device.id);
        task.clientId = device.id;
        task.assignedAt = Date.now();
        task.assignmentReason =
          "実行権限・空き枠を満たす接続から、空き枠数と最終割当時刻で選択";
        task.state = "assigned";
        task.updatedAt = Date.now();
        device.lastAssigned = Date.now();
        this.repository.put("task", task.id, task);
        this.repository.audit(device.id, "task.state.assigned", task.id);
        this.repository.put("device", device.id, device);
        this.repository.enqueue(device.id, {
          type: "execute",
          taskId: task.id,
          runId: task.runId,
          task: {
            ...task,
            participants: taskParticipants(this.repository, task, true),
          },
        });
      }
    });
  }
}
