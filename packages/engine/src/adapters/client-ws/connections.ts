import { randomUUID, verify } from "node:crypto";
import { WebSocket } from "ws";
import {
  frame,
  id,
  type Command,
  type Grant,
  type Task,
} from "../../../../common/src/contracts/protocol.js";
import { secret } from "../../../../common/src/runtime/platform.js";
import { Scheduler } from "../../clients/scheduler.js";
import type { Device } from "../../domain/models.js";
import type { Repository } from "../../ports/repository.js";
import { Tasks } from "../../processing/tasks/service.js";
import { PreviewRelay } from "./preview.js";
export class ClientConnections {
  readonly peers = new Map<string, WebSocket>();
  readonly ready = new Set<string>();
  readonly artifactRequests = new Map<
    string,
    {
      deviceId: string;
      runId: string;
      revision: number;
      resolve: (data: Command) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  readonly preview: PreviewRelay;
  readonly scheduler: Scheduler;
  readonly tasks: Tasks;
  constructor(
    readonly store: Repository,
    readonly changed: () => void,
    frameAncestors: () => string[] = () => [],
  ) {
    this.scheduler = new Scheduler(store);
    this.tasks = new Tasks(store);
    this.preview = new PreviewRelay(
      store,
      (id) => (this.ready.has(id) ? this.peers.get(id) : undefined),
      frameAncestors,
    );
  }
  connect(ws: WebSocket) {
    const challenge = secret();
    let deviceId: string | undefined,
      generation = 0;
    let authenticated = false;
    const timeout = setTimeout(
      () => ws.close(4001, "authentication timeout"),
      10000,
    );
    ws.send(JSON.stringify({ v: 1, type: "challenge", challenge }));
    ws.on("pong", () => {
      (ws as WebSocket & { alive?: boolean }).alive = true;
    });
    ws.on("error", () => {});
    ws.on("message", (raw) => {
      try {
        const data = frame(raw.toString());
        if (!authenticated) {
          if (data.type !== "authenticate") throw new Error("AUTH_REQUIRED");
          const device = this.store.get<Device>("device", id(data.deviceId));
          if (
            !device ||
            device.revoked ||
            this.store.user(device.userId)?.role === "viewer" ||
            !verify(
              null,
              Buffer.from(`ido:1:${device.id}:${challenge}`),
              device.publicKey,
              Buffer.from(String(data.signature), "base64"),
            )
          )
            throw new Error("AUTH_FAILED");
          deviceId = device.id;
          device.generation++;
          generation = device.generation;
          this.store.put("device", device.id, device);
          this.peers.get(device.id)?.close(4000, "superseded");
          this.ready.delete(device.id);
          this.peers.set(device.id, ws);
          authenticated = true;
          clearTimeout(timeout);
          ws.send(
            JSON.stringify({
              v: 1,
              type: "authenticated",
              generation,
              projects: this.store.list("project"),
            }),
          );
          return;
        }
        const device = this.store.get<Device>("device", deviceId!);
        if (
          !device ||
          device.revoked ||
          device.generation !== generation ||
          data.generation !== generation
        )
          throw new Error("STALE_CONNECTION");
        if (data.type === "artifact.result") {
          const pending = this.artifactRequests.get(String(data.requestId));
          if (
            pending &&
            pending.deviceId === device.id &&
            pending.runId === data.runId &&
            pending.revision === data.revision
          ) {
            clearTimeout(pending.timer);
            this.artifactRequests.delete(String(data.requestId));
            pending.resolve(data);
          }
          return;
        }
        if (data.type.startsWith("preview.")) {
          if (data.type === "preview.register")
            this.preview.register(device.id, data);
          else this.preview.receive(device.id, data);
          return;
        }
        if (data.type === "ready") {
          if (!Array.isArray(data.grants) || data.grants.length > 100)
            throw new Error("INVALID_GRANTS");
          device.grants = data.grants
            .map((g: Grant) => ({
              projectId: id(g.projectId),
              network: g.network === true,
              slots: Math.max(1, Math.min(8, Number(g.slots) || 1)),
            }))
            .filter((g) => !!this.store.get("project", g.projectId));
          device.slots = Math.max(1, Math.min(8, Number(data.slots) || 1));
          this.store.put("device", device.id, device);
          this.ready.add(device.id);
          this.flush();
        } else if (data.type === "ack") this.store.ack(device.id, id(data.id));
        else if (data.type === "result") {
          this.tasks.updateResult(device.id, generation, data);
          this.flush();
          this.changed();
        }
      } catch {
        ws.close(4003, "invalid message");
      }
    });
    ws.once("close", () => {
      clearTimeout(timeout);
      if (deviceId && this.peers.get(deviceId) === ws) {
        this.peers.delete(deviceId);
        this.ready.delete(deviceId);
        this.preview.disconnected(deviceId);
      }
    });
  }
  flush() {
    this.scheduler.schedule(this.ready);
    for (const deviceId of this.ready) {
      const socket = this.peers.get(deviceId);
      const device = this.store.get<Device>("device", deviceId);
      if (socket?.readyState === WebSocket.OPEN && device)
        for (const command of this.store.pending(deviceId))
          socket.send(
            JSON.stringify({ ...command, generation: device.generation }),
          );
    }
  }

  async artifact(taskId: string) {
    const task = this.store.get<Task>("task", taskId);
    const device =
      task?.clientId && this.store.get<Device>("device", task.clientId);
    const socket = task?.clientId && this.peers.get(task.clientId);
    if (!task || !device || !socket || !this.ready.has(device.id))
      throw new Error("CLIENT_OFFLINE");
    const requestId = randomUUID();
    return new Promise<Command>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.artifactRequests.delete(requestId);
        reject(new Error("ARTIFACT_TIMEOUT"));
      }, 15000);
      this.artifactRequests.set(requestId, {
        deviceId: device.id,
        runId: task.runId,
        revision: task.revision,
        resolve,
        reject,
        timer,
      });
      socket.send(
        JSON.stringify({
          v: 1,
          type: "artifact.request",
          requestId,
          taskId,
          runId: task.runId,
          revision: task.revision,
          generation: device.generation,
        }),
      );
    });
  }
  close() {
    for (const request of this.artifactRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("CLIENT_OFFLINE"));
    }
    this.artifactRequests.clear();
    for (const peer of this.peers.values()) peer.terminate();
    this.preview.close();
  }
}
