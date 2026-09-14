import { sign } from "node:crypto";
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
    if (this.ws !== ws) return;
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
      this.generation = Number(data.generation);
      this.connected = true;
      this.controlSupported = data.controlVersion === 1;
      this.teamTasksSupported = data.taskListVersion === 1;
      this.status = "connected";
      this.settings.projects = data.projects as Project[];
      void this.save();
      for (const value of Object.values(this.executor.runs))
        this.executor.report(value);
      this.ready();
      return;
    }
    if (data.type.startsWith("preview.")) {
      void this.preview.receive(data).catch(() => {});
      return;
    }
    if (data.generation !== this.generation) return;
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
    this.processing = this.processing
      .catch(() => {})
      .then(() =>
        this.executor.receive(
          data,
          this.settings.mappings,
          this.allow,
          this.settings.slots,
        ),
      )
      .catch(() => {
        this.status = "command failed; check local execution";
      });
  });
  ws.once("close", (code) => {
    if (this.ws !== ws) return;
    this.connected = false;
    this.controlSupported = false;
    this.teamTasksSupported = false;
    this.teamTasks = undefined;
    for (const request of this.controlRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new HttpError(409, "CONTROL_DELIVERY_UNKNOWN"));
    }
    this.controlRequests.clear();
    this.status = code === 4003 ? "revoked or permission changed" : "offline";
    this.preview.close();
    if (!this.stopping && code !== 4003)
      this.reconnect = setTimeout(() => void this.connect(), 3000);
  });
}
