import { randomUUID } from "node:crypto";
import { HttpError } from "@ido/common/runtime/http";
import type { Client } from "../bootstrap/client.js";
export function workspaceRequest<T>(
  this: Client,
  operation: string,
  input: Record<string, unknown>,
): Promise<T> {
  if (!this.connected || !this.workspaceSupported)
    return Promise.reject(new HttpError(409, "PROJECT_CONNECTION_REQUIRED"));
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      this.workspaceRequests.delete(requestId);
      reject(new HttpError(409, "WORKSPACE_DELIVERY_UNKNOWN"));
    }, 15000);
    this.workspaceRequests.set(requestId, {
      resolve: resolve as (value: unknown) => void,
      reject,
      timer,
    });
    this.emit({ v: 1, type: "workspace.request", requestId, operation, input });
  });
}
