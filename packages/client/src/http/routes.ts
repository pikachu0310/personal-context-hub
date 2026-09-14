import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { id, text } from "../../../common/src/contracts/protocol.js";
import {
  asset,
  body,
  headers,
  HttpError,
  localGuard,
  send,
} from "../../../common/src/runtime/http.js";
import {
  equal,
  run,
  workerEnvironment,
} from "../../../common/src/runtime/platform.js";
import { codexBinary } from "../execution/executor.js";

import type { Client } from "../bootstrap/client.js";
export async function route(
  this: Client,
  req: IncomingMessage,
  res: ServerResponse,
) {
  headers(res);
  localGuard(req, this.origin);
  const url = new URL(req.url ?? "/", this.origin);
  if (url.pathname === "/health") {
    send(res, 200, { ok: true, service: "ido-client", protocol: 1 });
    return;
  }
  if (!url.pathname.startsWith("/api/")) {
    await asset(req, res, this.uiDirectory, url.pathname);
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/state") {
    send(res, 200, {
      mode: "client",
      csrf: this.csrf,
      settings: this.settings,
      connected: this.connected,
      status: this.status,
      allow: this.allow,
      loginStatus: this.loginStatus,
      pairing: this.pairing
        ? { url: this.pairing.url, fingerprint: this.pairing.fingerprint }
        : null,
      runs: Object.values(this.executor.runs),
      approvals: [...this.executor.approvals].map(
        ([id, { method, params }]) => ({ id, method, params }),
      ),
    });
    return;
  }
  if (
    req.method !== "POST" ||
    !equal(String(req.headers["x-csrf-token"] ?? ""), this.csrf)
  )
    throw new HttpError(403, "CSRF_REQUIRED");
  const input = await body(req);
  switch (url.pathname) {
    case "/api/pair":
      await this.pair(text(input.engineUrl, 2048));
      break;
    case "/api/disconnect": {
      if (this.executor.active.size)
        throw new HttpError(409, "STOP_TASKS_FIRST");
      this.allow = false;
      this.settings.deviceId = undefined;
      this.settings.engineUrl = undefined;
      this.settings.projects = [];
      this.settings.mappings = [];
      clearTimeout(this.reconnect);
      this.ws?.close();
      this.connected = false;
      this.preview.close();
      await this.save();
      break;
    }
    case "/api/mappings": {
      if (this.allow || this.executor.active.size)
        throw new HttpError(409, "PAUSE_BEFORE_EDITING");
      const directory = await realpath(text(input.directory, 4000));
      await run("git", ["-C", directory, "rev-parse", "--show-toplevel"]);
      const projectId = id(input.projectId);
      if (!this.settings.projects.some((p) => p.id === projectId))
        throw new HttpError(400, "UNKNOWN_PROJECT");
      this.settings.mappings = this.settings.mappings
        .filter((m) => m.projectId !== projectId)
        .concat({
          projectId,
          directory,
          network: input.network === true,
          slots: Math.max(1, Math.min(8, Number(input.slots) || 1)),
        });
      await this.save();
      break;
    }
    case "/api/allow":
      this.allow = input.allow === true;
      this.settings.slots = Math.max(1, Math.min(8, Number(input.slots) || 1));
      await this.save();
      this.ready();
      break;
    case "/api/approval":
      this.executor.approve(id(input.id), input.allow === true);
      break;
    case "/api/codex/doctor":
      try {
        await run(codexBinary(), ["login", "status"], {
          env: workerEnvironment(this.executor.home),
        });
        this.loginStatus = "authenticated";
      } catch {
        this.loginStatus = "login required";
      }
      break;
    case "/api/codex/login": {
      if (this.login) throw new Error("LOGIN_ALREADY_RUNNING");
      this.loginStatus = "Follow the official Codex login in the terminal.";
      const child = spawn(codexBinary(), ["login", "--device-auth"], {
        env: workerEnvironment(this.executor.home),
        stdio: "inherit",
      });
      this.login = child;
      child.once("error", () => {
        this.loginStatus = "Codex unavailable";
        this.login = undefined;
      });
      child.once("exit", (code) => {
        this.loginStatus = code === 0 ? "authenticated" : "login failed";
        this.login = undefined;
      });
      break;
    }
    case "/api/stop": {
      const value = this.executor.runs[id(input.runId)];
      if (!value) throw new Error("RUN_NOT_FOUND");
      await this.executor.receive(
        {
          v: 1,
          type: "stop",
          id: randomUUID(),
          runId: value.task.runId,
          taskId: value.task.id,
        },
        this.settings.mappings,
        this.allow,
        this.settings.slots,
      );
      break;
    }
    case "/api/preview": {
      const value = this.executor.runs[id(input.runId)];
      if (!value) throw new Error("RUN_NOT_FOUND");
      const port = Number(input.port);
      if ([new URL(this.origin).port].includes(String(port)))
        throw new Error("MANAGEMENT_PORT_FORBIDDEN");
      if (!Number.isInteger(port) || port < 1024 || port > 65535)
        throw new Error("INVALID_PORT");
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`, {
          redirect: "error",
          signal: AbortSignal.timeout(1500),
        });
        const info = (await response.json()) as { service?: string };
        if (info.service?.startsWith("ido-"))
          throw new HttpError(403, "MANAGEMENT_PORT_FORBIDDEN");
      } catch (e) {
        if (e instanceof HttpError) throw e;
      }
      const previewId = randomUUID();
      this.preview.register(previewId, port);
      this.emit({
        v: 1,
        type: "preview.register",
        previewId,
        taskId: value.task.id,
        runId: value.task.runId,
        revision: value.task.revision,
      });
      break;
    }
    default:
      throw new HttpError(404, "NOT_FOUND");
  }
  send(res, 200, { ok: true });
}
