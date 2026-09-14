import { taskParticipants } from "../../processing/projects/task-participants.js";
import { deviceIdentity } from "../../clients/identity.js";
import type { TeamTaskSnapshot } from "@ido/common/contracts/api";
import { clean, type Task } from "@ido/common/contracts/protocol";
import type { Device } from "../../domain/models.js";
import type { Repository } from "../../ports/repository.js";

export function taskSnapshot(
  store: Repository,
  connected: ReadonlyMap<string, unknown>,
  projectIds: ReadonlySet<string>,
): TeamTaskSnapshot {
  const active = (task: Task) =>
    ["running", "assigned", "queued"].includes(task.state);
  const tasks = store
    .list<Task>("task")
    .filter((task) => projectIds.has(task.projectId))
    .sort(
      (a, b) =>
        Number(active(b)) - Number(active(a)) || b.updatedAt - a.updatedAt,
    );
  return {
    profiles: [
      ...new Set(
        tasks.flatMap((task) => taskParticipants(store, task).map((p) => p.id)),
      ),
    ]
      .slice(0, 200)
      .flatMap((id) => {
        const device = store.get<Device>("device", id);
        return device && !device.revoked && device.profile?.avatar
          ? [
              {
                id,
                identityId: deviceIdentity(store, device),
                name: clean(device.profile.name).slice(0, 100),
                avatar: device.profile.avatar,
              },
            ]
          : [];
      }),
    updatedAt: Date.now(),
    total: tasks.length,
    tasks: tasks.slice(0, 200).map((task) => {
      const device = task.clientId
        ? store.get<Device>("device", task.clientId)
        : undefined;
      return {
        participants: taskParticipants(store, task),
        id: task.id,
        runId: task.runId,
        revision: task.revision,
        projectId: task.projectId,
        title: clean(task.title ?? task.text).slice(0, 300),
        state: task.state,
        clientId: task.clientId,
        clientIdentityId: device ? deviceIdentity(store, device) : undefined,
        updatedAt: task.updatedAt,
        ownerName: device
          ? clean(device.profile?.name ?? device.name).slice(0, 100)
          : undefined,
        deviceName: device ? clean(device.name).slice(0, 100) : undefined,
        deviceConnected: device
          ? !device.revoked && connected.has(device.id)
          : false,
        progress: task.progress
          ? clean(task.progress).slice(0, 1000)
          : undefined,
      };
    }),
  };
}
