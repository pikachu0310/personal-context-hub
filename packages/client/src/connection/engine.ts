import { receiveSharedLocalControl } from "./local-sharing.js";
import { randomUUID, sign } from "node:crypto";
import { WebSocket } from "ws";
import { HttpError } from "@ido/common/runtime/http";
import type { WorkReceipt } from "@ido/common/contracts/work";
import type { TeamTaskSnapshot } from "@ido/common/contracts/api";
import {
  frame,
  type Command,
  type Project,
} from "@ido/common/contracts/protocol";

import type { Client } from "../bootstrap/client.js";
export async function connect(this: Client) {
  if (this.stopping || !this.settings.engineUrl || !this.settings.deviceId)
    return;
  clearTimeout(this.reconnect);
  this.ws?.close();
  this.connected = false;
  this.controlSupported = false;
  this.lifecycleSupported = false;
  this.continuationSupported = false;
  this.projectCreationSupported = false;
  this.teamTasksSupported = false;
  this.teamTasks = undefined;
  this.teamTasksRequestedAt = 0;
  this.status = "connecting";
  const privateKey = await this.credentials.get("device.privateKey");
  if (!privateKey) {
    this.status = "device key unavailable";
    return;
  }
  const url = new URL("/connect", this.settings.engineUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(url, {
    maxPayload: 3 * 1024 * 1024,
    perMessageDeflate: false,
    handshakeTimeout: 10000,
  });
  this.ws = ws;
  ws.on("error", () => {});
  ws.on("message", (raw) => {
    if (this.ws !== ws || this.stopping) return;
    let data: Command;
    try {
      data = frame(raw.toString());
    } catch {
      ws.close();
      return;
    }
    if (data.type === "challenge") {
      ws.send(
        JSON.stringify({
          v: 1,
          type: "authenticate",
          deviceId: this.settings.deviceId,
          lifecycleVersion: 1,
          profile: {
            ...this.settings.profile,
            name: this.settings.profile?.name || "参加者",
            codexConnected: this.loginStatus === "authenticated",
          },
          signature: sign(
            null,
            Buffer.from(
              `ido:1:${this.settings.deviceId}:${String(data.challenge)}`,
            ),
            privateKey,
          ).toString("base64"),
        }),
      );
      return;
    }
    if (data.type === "authenticated") {
      this.settings.identityId =
        typeof data.identityId === "string" &&
        /^client:[a-f0-9]{64}$/.test(data.identityId)
          ? data.identityId
          : undefined;
      this.generation = Number(data.generation);
      this.connected = true;
      this.controlSupported = data.controlVersion === 1;
      this.continuationSupported = data.continuationVersion === 1;
      this.projectCreationSupported = data.projectVersion === 1;
      this.workspaceSupported = data.workspaceVersion === 1;
      this.localSharingSupported = data.localSharingVersion === 1;
      void this.syncLocalShares();
      this.teamTasksSupported = data.taskListVersion === 1;
      this.lifecycleSupported = data.lifecycleVersion === 1;
      this.status = "connected";
      this.syncProjects(data.projects as Project[]);
      if (Array.isArray(data.tasks))
        this.projectTasks =
          data.tasks as import("@ido/common/contracts/protocol").Task[];
      void this.save();
      this.processing = this.processing
        .catch(() => {})
        .then(async () => {
          for (const command of (Array.isArray(data.deletions)
            ? data.deletions
            : []) as Command[])
            await this.executor.receive(command, [], false, 0);
          if (this.ws !== ws || this.stopping) return;
          for (const value of Object.values(this.executor.runs))
            this.executor.report(value);
          this.ready();
        })
        .catch(() => {
          this.status = "削除履歴の同期を再試行しています";
          this.ready();
        });
      return;
    }
    if (data.type.startsWith("preview.")) {
      void this.preview.receive(data).catch(() => {});
      return;
    }
    if (data.generation !== this.generation) return;
    if (data.type === "projects.updated") {
      this.syncProjects(
        data.projects as Project[],
        Array.isArray(data.tasks)
          ? (data.tasks as import("@ido/common/contracts/protocol").Task[])
          : undefined,
      );
      void this.save();
      return;
    }
    if (data.type === "workspace.result") {
      const request = this.workspaceRequests.get(String(data.requestId));
      if (request) {
        clearTimeout(request.timer);
        this.workspaceRequests.delete(String(data.requestId));
        if (data.error) request.reject(new HttpError(409, String(data.error)));
        else request.resolve(data.result);
      }
      return;
    }
    if (data.type === "project.result") {
      const request = this.projectRequests.get(String(data.requestId));
      if (request) {
        clearTimeout(request.timer);
        this.projectRequests.delete(String(data.requestId));
        if (data.error) request.reject(new HttpError(409, String(data.error)));
        else request.resolve(data.project as Project);
      }
      return;
    }
    if (data.type === "tasks.snapshot") {
      this.teamTasks = data.snapshot as TeamTaskSnapshot;
      return;
    }
    if (data.type === "work.control.result") {
      const request = this.controlRequests.get(String(data.requestKey));
      if (request) {
        clearTimeout(request.timer);
        this.controlRequests.delete(String(data.requestKey));
        if (data.error) request.reject(new HttpError(409, String(data.error)));
        else request.resolve(data.receipt as WorkReceipt);
      }
      return;
    }
    if (data.type === "artifact.request") {
      const value = this.executor.runs[String(data.runId)];
      if (
        !value ||
        value.origin === "local" ||
        value.task.id !== data.taskId ||
        value.task.revision !== data.revision
      )
        return;
      void this.executor
        .artifact(value.task.runId)
        .then((artifact) =>
          this.emit({
            v: 1,
            type: "artifact.result",
            requestId: data.requestId,
            taskId: value.task.id,
            runId: value.task.runId,
            ...artifact,
          }),
        )
        .catch(() =>
          this.emit({
            v: 1,
            type: "artifact.result",
            requestId: data.requestId,
            taskId: value.task.id,
            runId: value.task.runId,
            revision: value.task.revision,
            error: "DIFF_UNAVAILABLE",
          }),
        );
      return;
    }
    if (data.type === "task.purge" && data.taskId)
      this.preview.removeTask(data.taskId);
    this.processing = this.processing
      .catch(() => {})
      .then(async () => {
        if (await receiveSharedLocalControl(this, data)) return;
        return this.executor.receive(
          data,
          this.executionMappings(),
          this.allow,
          this.settings.slots,
        );
      })
      .catch(() => {
        this.status = "command failed; check local execution";
      });
  });
  ws.once("close", (code) => {
    if (this.ws !== ws) return;
    this.connected = false;
    this.controlSupported = false;
    this.lifecycleSupported = false;
    this.continuationSupported = false;
    this.projectCreationSupported = false;
    this.teamTasksSupported = false;
    this.teamTasks = undefined;
    for (const request of this.controlRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new HttpError(409, "CONTROL_DELIVERY_UNKNOWN"));
    }
    this.controlRequests.clear();
    for (const request of this.projectRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new HttpError(409, "PROJECT_DELIVERY_UNKNOWN"));
    }
    this.projectRequests.clear();
    for (const request of this.workspaceRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new HttpError(409, "WORKSPACE_DELIVERY_UNKNOWN"));
    }
    this.workspaceRequests.clear();
    this.workspaceSupported = false;
    this.localSharingSupported = false;
    this.status =
      code === 4004
        ? "管理者が接続を切断しました。再接続できます。"
        : code === 4003
          ? "revoked or permission changed"
          : "offline";
    if (code === 4004) {
      const targets = Object.values(this.executor.runs).filter(
        (r) =>
          r.origin !== "local" &&
          ["assigned", "running", "interrupted"].includes(r.state),
      );
      // Stop only runs present on this connection, never local work or later runs.
      for (const run of targets)
        this.executor.active.get(run.task.runId)?.abort.abort();
      const stopping: Command[] = targets.map((run) => ({
        v: 1,
        type: "stop",
        id: randomUUID(),
        taskId: run.task.id,
        runId: run.task.runId,
        revision: run.task.revision,
        task: structuredClone(run.task),
      }));
      this.processing = this.processing
        .catch(() => {})
        .then(async () => {
          for (const command of stopping)
            await this.executor.receive(
              command,
              this.executionMappings(),
              this.allow,
              this.settings.slots,
            );
        })
        .catch(() => {
          this.status = "切断しました。実行停止を端末で確認してください。";
        });
    }
    this.preview.close();
    if (!this.stopping && code !== 4003 && code !== 4004)
      this.reconnect = setTimeout(() => void this.connect(), 3000);
  });
}
