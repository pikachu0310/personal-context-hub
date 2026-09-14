import { randomUUID } from "node:crypto";
import type { Project } from "@ido/common/contracts/protocol";
import { HttpError } from "@ido/common/runtime/http";
import type { Client } from "../bootstrap/client.js";
export function createProject(
  this: Client,
  name: string,
  requestId: string = randomUUID(),
): Promise<Project> {
  if (!this.connected || !this.projectCreationSupported)
    return Promise.reject(new HttpError(409, "PROJECT_CONNECTION_REQUIRED"));
  return new Promise((resolve, reject) => {
    if (this.projectRequests.has(requestId))
      return reject(new HttpError(409, "PROJECT_REQUEST_BUSY"));
    const timer = setTimeout(() => {
      this.projectRequests.delete(requestId);
      reject(new HttpError(409, "PROJECT_DELIVERY_UNKNOWN"));
    }, 15000);
    this.projectRequests.set(requestId, { resolve, reject, timer });
    this.emit({ v: 1, type: "project.create", requestId, name });
  });
}
