import type { Task } from "../../../common/src/contracts/protocol.js";
import type { Device } from "../domain/models.js";
import type { Repository } from "../ports/repository.js";
import {
  requiresPolicySupport,
  restrictExecutionPolicy,
} from "../../../common/src/contracts/work.js";
export class Scheduler {
  constructor(readonly repository: Repository) {}
  schedule(online: Set<string>) {
    return this.repository.transaction(() => {
      const tasks = this.repository.list<Task>("task");
      const devices = this.repository
        .list<Device>("device")
        .filter(
          (d) =>
            online.has(d.id) &&
            !d.revoked &&
            this.repository.user(d.userId)?.role !== "viewer",
        );
      for (const task of tasks.filter(
        (t) => t.state === "queued" && !t.clientId,
      )) {
        const active = (device: Device) =>
          tasks.filter(
            (t) =>
              t.clientId === device.id &&
              ["assigned", "running", "interrupted"].includes(t.state),
          ).length;
        const eligible = devices.filter(
          (d) =>
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
        task.clientId = device.id;
        task.state = "assigned";
        task.updatedAt = Date.now();
        device.lastAssigned = Date.now();
        this.repository.put("task", task.id, task);
        this.repository.put("device", device.id, device);
        this.repository.enqueue(device.id, {
          type: "execute",
          taskId: task.id,
          runId: task.runId,
          task,
        });
      }
    });
  }
}
