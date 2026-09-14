import type { PluginEvent } from "@ido/common/contracts/plugins";
import type { Task } from "@ido/common/contracts/protocol";
import type { Repository } from "../../ports/repository.js";
export class TaskEvents {
  private snapshots = new Map<string, string>();
  constructor(
    readonly repository: Repository,
    readonly publish: (event: PluginEvent) => void,
  ) {}
  flush() {
    const tasks = this.repository.list<Task>("task");
    for (const id of this.snapshots.keys())
      if (!this.repository.get("meeting", id)) this.snapshots.delete(id);
    for (const meeting of this.repository.list<{ id: string }>("meeting")) {
      const data = tasks.filter((task) => task.meetingId === meeting.id);
      const snapshot = JSON.stringify(data);
      if (this.snapshots.get(meeting.id) === snapshot) continue;
      this.snapshots.set(meeting.id, snapshot);
      this.publish({ type: "tasks", meetingId: meeting.id, data });
    }
  }
}
