import { attachTaskSource } from "@ido/common/contracts/protocol";
import { projectDirectory } from "../execution/project-directory.js";
import { startLogin } from "../auth/login.js";
import { startClaudeLogin, checkClaudeLogin } from "../auth/claude.js";
import { activityText } from "../execution/activity.js";
import {
  startLocalTask,
  localInstruction,
  continueLocalTask,
  localProgress,
} from "../execution/local-tasks.js";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { realpath } from "node:fs/promises";
import { type IncomingMessage, type ServerResponse } from "node:http";
import { avatar, id, text } from "@ido/common/contracts/protocol";
import {
  asset,
  body,
  headers,
  HttpError,
  localGuard,
  send,
} from "@ido/common/runtime/http";
import { equal, run } from "@ido/common/runtime/platform";

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
    if (
      this.connected &&
      this.teamTasksSupported &&
      Date.now() - this.teamTasksRequestedAt >= 2500
    ) {
      this.teamTasksRequestedAt = Date.now();
      this.emit({ v: 1, type: "tasks.list" });
    }
    send(res, 200, {
      mode: "client",
      csrf: this.csrf,
      settings: this.settings,
      suggestedInvite: this.suggestedInvite,
      projectTasks: this.projectTasks,
      connected: this.connected,
      lifecycleSupported: this.lifecycleSupported,
      deletionSync: {
        pendingTasks: Object.keys(this.executor.pendingPurges).length,
      },
      controlSupported: this.controlSupported,
      continuationSupported: this.continuationSupported,
      projectCreationSupported: this.projectCreationSupported,
      teamTasksSupported: this.teamTasksSupported,
      teamTasks: this.connected ? this.teamTasks : undefined,
      status: this.status,
      allow: this.allow,
      allowedProjectIds: [...this.allowedProjects],
      loginStatus: this.loginStatus,
      account: this.account,
      identity: { status: this.identityStatus, directory: this.directory },
      claudeLoginStatus: this.claudeLoginStatus,
      claudeLoginUrl: this.claudeLoginUrl,
      loginUrl: this.loginUrl,
      suggestedEngine: this.suggestedEngine,
      desktop: this.desktop,
      pairing: this.pairing
        ? { url: this.pairing.url, fingerprint: this.pairing.fingerprint }
        : null,
      runs: Object.values(this.executor.runs)
        .filter(
          (r) =>
            !this.executor.deletedTasks[r.task.id] &&
            this.settings.projects.some((p) => p.id === r.task.projectId),
        )
        .map(
          ({
            activity,
            activityDropped,
            instructions,
            pendingInstructions,
            controlReceipts,
            ...value
          }) => value,
        ),
      approvals: [...this.executor.approvals].map(
        ([id, { runId, method, params }]) => ({ id, runId, method, params }),
      ),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/activity") {
    const value = this.executor.runs[id(url.searchParams.get("runId"))];
    if (!value || this.executor.deletedTasks[value.task.id])
      throw new HttpError(404, "RUN_NOT_FOUND");
    send(res, 200, {
      entries: value.activity ?? [],
      dropped: value.activityDropped ?? 0,
      version: value.activityVersion ?? 0,
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/task-environment") {
    const value = this.executor.runs[id(url.searchParams.get("runId"))];
    if (!value || this.executor.deletedTasks[value.task.id])
      throw new HttpError(404, "RUN_NOT_FOUND");
    const git = (args: string[]) =>
      run("git", ["-C", value.directory, ...args], { timeout: 5000 })
        .then((output) => output.trim())
        .catch(() => undefined);
    const [branch, commit] = await Promise.all([
      git(["symbolic-ref", "--quiet", "--short", "HEAD"]),
      git(["rev-parse", "--verify", "HEAD"]),
    ]);
    send(res, 200, {
      directory: value.directory,
      branch,
      commit,
      deviceName: hostname(),
      ownerName: this.settings.profile?.name,
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/api/local-tasks/progress") {
    send(res, 200, localProgress(this.executor.runs));
    return;
  }
  if (
    req.method !== "POST" ||
    !equal(String(req.headers["x-csrf-token"] ?? ""), this.csrf)
  )
    throw new HttpError(403, "CSRF_REQUIRED");
  const input = await body(req);
  switch (url.pathname) {
    case "/api/task/sources": {
      const runId = input.runId ? id(input.runId) : undefined;
      const value = runId ? this.executor.runs[runId] : undefined;
      if (runId) {
        if (
          !value ||
          value.task.id !== id(input.taskId) ||
          this.executor.deletedTasks[value.task.id] ||
          (value.origin !== "local" &&
            !this.settings.projects.some(
              (project) => project.id === value.task.projectId,
            ))
        )
          throw new HttpError(404, "RUN_NOT_FOUND");
        if (input.sourceId) {
          value.task.attachedSources = attachTaskSource(
            value.task.attachedSources,
            input,
          );
          await this.executor.save();
        }
        send(res, 200, { sources: value.task.attachedSources ?? [] });
      } else {
        send(res, 200, await this.workspaceRequest("task.sources", input));
      }
      return;
    }
    case "/api/model-settings": {
      const value = input.runId
        ? this.executor.runs[id(input.runId)]
        : this.settings.mappings.find(
            (m) => m.projectId === id(input.projectId),
          );
      if (
        !value ||
        ("task" in value && this.executor.deletedTasks[value.task.id])
      )
        throw new HttpError(404, "RUN_NOT_FOUND");
      const agent = "task" in value ? (value.agent ?? "codex") : "codex";
      if (!input.read) {
        const available = (await this.agentCatalog()).find(
          (entry) => entry.agent === agent && entry.authenticated,
        );
        if (!available) throw new HttpError(409, "AGENT_LOGIN_REQUIRED");
        const model = available.models.find(
          (entry) => entry.id === input.model,
        );
        if (!model) throw new HttpError(409, "MODEL_UNAVAILABLE");
        const effort = input.reasoningEffort || undefined;
        if (
          effort !== undefined &&
          (typeof effort !== "string" ||
            !model.supportedEfforts?.includes(effort))
        )
          throw new HttpError(400, "EFFORT_UNAVAILABLE");
        value.model = model.id;
        value.reasoningEffort = effort;
        if ("task" in value) await this.executor.save();
        else await this.save();
      }
      send(res, 200, {
        model: value.model,
        reasoningEffort: value.reasoningEffort,
        progressMode:
          ("pendingProgressMode" in value
            ? value.pendingProgressMode
            : undefined) ??
          value.progressMode ??
          "auto",
      });
      return;
    }
    case "/api/agents/models":
      send(res, 200, { agents: await this.agentCatalog() });
      return;
    case "/api/claude/login":
      startClaudeLogin(this);
      break;
    case "/api/claude/doctor":
      await checkClaudeLogin(this);
      break;
    case "/api/local-tasks/start": {
      const result = await startLocalTask(this, input);
      send(res, 200, { ok: true, ...result });
      return;
    }
    case "/api/pair":
      await this.pair(text(input.engineUrl, 2048));
      this.suggestedEngine = undefined;
      break;
    case "/api/reconnect": {
      if (!this.settings.deviceId || !this.settings.engineUrl)
        throw new HttpError(409, "PAIRING_REQUIRED");
      if (!this.connected && this.status !== "connecting") await this.connect();
      break;
    }
    case "/api/disconnect": {
      if (this.executor.active.size)
        throw new HttpError(409, "STOP_TASKS_FIRST");
      this.allowedProjects.clear();
      this.settings.deviceId = undefined;
      delete this.settings.identityId;
      this.settings.engineUrl = undefined;
      this.settings.projects = [];
      this.settings.mappings = [];
      delete this.settings.pendingProject;
      clearTimeout(this.reconnect);
      this.ws?.close();
      this.connected = false;
      this.teamTasks = undefined;
      this.teamTasksSupported = false;
      this.preview.close();
      await this.save();
      break;
    }
    case "/api/profile": {
      this.settings.profile = {
        name: text(input.name, 100),
        avatar: avatar(
          input.avatar === undefined
            ? this.settings.profile?.avatar
            : input.avatar,
        ),
        context:
          typeof input.context === "string" ? input.context.slice(0, 8000) : "",
      };
      await this.save();
      this.ready();
      break;
    }
    case "/api/project/invite": {
      const result = await this.workspaceRequest<{ token: string }>(
        "project.invite",
        { projectId: id(input.projectId) },
      );
      send(res, 200, {
        url: `${this.settings.engineUrl}/invite/${result.token}`,
      });
      return;
    }
    case "/api/project/leave": {
      const projectId = id(input.projectId);
      if (
        Object.values(this.executor.runs).some(
          (r) =>
            r.task.projectId === projectId &&
            (this.executor.active.has(r.task.runId) ||
              ["running", "assigned", "interrupted"].includes(r.state) ||
              Object.values(r.controlReceipts ?? {}).some(
                (c) => c.delivery === "uncertain",
              )),
        )
      )
        throw new HttpError(409, "PROJECT_TASKS_ACTIVE");
      const result = await this.workspaceRequest("project.leave", input);
      this.syncProjects(
        this.settings.projects.filter((p) => p.id !== projectId),
      );
      await this.save();
      this.ready();
      send(res, 200, result);
      return;
    }
    case "/api/task/join":
    case "/api/task/leave":
    case "/api/task/delete":
    case "/api/project/transfer-owner":
    case "/api/project/rename":
    case "/api/project/remove-member":
    case "/api/project/minutes/update":
    case "/api/project/snapshot":
    case "/api/project/knowledge":
    case "/api/project/transcript":
    case "/api/project/task":
    case "/api/project/continue": {
      if (
        url.pathname === "/api/project/continue" &&
        !this.continuationSupported
      )
        throw new HttpError(409, "CONTINUATION_UNSUPPORTED");
      const operations: Record<string, string> = {
        "/api/task/join": "task.join",
        "/api/task/leave": "task.leave",
        "/api/task/delete": "task.delete",
        "/api/project/transfer-owner": "project.transfer-owner",
        "/api/project/rename": "project.rename",
        "/api/project/remove-member": "project.remove-member",
        "/api/project/snapshot": "project.snapshot",
        "/api/project/knowledge": "project.knowledge",
        "/api/project/transcript": "project.transcript",
        "/api/project/minutes/update": "project.minutes.update",
        "/api/project/task": "task.create",
        "/api/project/continue": "task.continue",
      };
      const result = await this.workspaceRequest(
        operations[url.pathname],
        input,
      );
      if (url.pathname === "/api/task/delete") {
        const taskId = id(input.taskId);
        this.projectTasks = this.projectTasks.filter((t) => t.id !== taskId);
        if (this.teamTasks)
          this.teamTasks.tasks = this.teamTasks.tasks.filter(
            (t) => t.id !== taskId,
          );
      }
      send(res, 200, result);
      return;
    }
    case "/api/project/inspect-invite": {
      if (input.engineUrl !== this.settings.engineUrl)
        throw new HttpError(409, "INVITATION_ENGINE_MISMATCH");
      const result = await this.workspaceRequest("project.inspect-invite", {
        token: text(input.token, 200),
      });
      send(res, 200, result);
      return;
    }
    case "/api/project/join": {
      if (input.engineUrl !== this.settings.engineUrl)
        throw new HttpError(409, "INVITATION_ENGINE_MISMATCH");
      if (this.allow || this.executor.active.size)
        throw new HttpError(409, "PAUSE_BEFORE_EDITING");
      const token = text(input.token, 200);
      await this.workspaceRequest("project.inspect-invite", { token });
      const directory = await projectDirectory(text(input.directory, 4000));
      if (this.allow || this.executor.active.size)
        throw new HttpError(409, "PAUSE_BEFORE_EDITING");
      const project = await this.workspaceRequest<
        import("@ido/common/contracts/protocol").Project
      >("project.join", { token });
      if (this.allow || this.executor.active.size)
        throw new HttpError(409, "PAUSE_BEFORE_EDITING");
      this.settings.mappings = this.settings.mappings
        .filter((m) => m.projectId !== project.id)
        .concat({ projectId: project.id, directory, network: false, slots: 1 });
      this.suggestedInvite = undefined;
      await this.save();
      this.ready();
      break;
    }
    case "/api/projects": {
      if (this.projectCreationBusy)
        throw new HttpError(409, "PROJECT_REQUEST_BUSY");
      this.projectCreationBusy = true;
      try {
        if (!this.connected || !this.projectCreationSupported)
          throw new HttpError(409, "PROJECT_CONNECTION_REQUIRED");
        if (this.allow || this.executor.active.size)
          throw new HttpError(409, "PAUSE_BEFORE_EDITING");
        const name = text(input.name, 100);
        if (
          this.settings.projects.some(
            (p) =>
              p.name.normalize("NFKC").toLowerCase() ===
              name.normalize("NFKC").toLowerCase(),
          ) &&
          !this.settings.pendingProject
        )
          throw new HttpError(409, "PROJECT_NAME_EXISTS");
        const path = await realpath(text(input.directory, 4000));
        const pending = this.settings.pendingProject;
        if (
          pending &&
          (pending.name !== name ||
            pending.directory !== path ||
            pending.engineUrl !== this.settings.engineUrl ||
            pending.deviceId !== this.settings.deviceId)
        )
          throw new HttpError(409, "FINISH_PENDING_PROJECT_FIRST");
        const directory = await projectDirectory(path);
        if (this.allow || this.executor.active.size)
          throw new HttpError(409, "PAUSE_BEFORE_EDITING");
        this.settings.pendingProject ??= {
          requestId: randomUUID(),
          name,
          directory,
          engineUrl: this.settings.engineUrl,
          deviceId: this.settings.deviceId,
        };
        await this.save();
        let project;
        try {
          project = await this.createProject(
            name,
            this.settings.pendingProject.requestId,
          );
        } catch (error) {
          if (
            error instanceof Error &&
            [
              "PROJECT_NAME_EXISTS",
              "PROJECT_REQUEST_MISMATCH",
              "INVALID_TEXT",
              "PERMISSION_DENIED",
            ].includes(error.message)
          ) {
            delete this.settings.pendingProject;
            await this.save();
          }
          throw error;
        }
        if (this.allow || this.executor.active.size)
          throw new HttpError(409, "PAUSE_BEFORE_EDITING");
        if (!this.settings.projects.some((p) => p.id === project.id))
          this.settings.projects.push(project);
        this.settings.mappings = this.settings.mappings
          .filter((m) => m.projectId !== project.id)
          .concat({
            projectId: project.id,
            directory,
            network: input.network === true,
            progressMode: input.progressMode === "manual" ? "manual" : "auto",
            slots: 1,
          });
        delete this.settings.pendingProject;
        await this.save();
        if (input.allow === true) this.allowedProjects.add(project.id);
        this.ready();
      } finally {
        this.projectCreationBusy = false;
      }
      break;
    }
    case "/api/mappings": {
      const projectId = id(input.projectId);
      if (this.projectBusy(projectId))
        throw new HttpError(409, "PAUSE_BEFORE_EDITING");
      if (!this.settings.projects.some((p) => p.id === projectId))
        throw new HttpError(400, "UNKNOWN_PROJECT");
      const directory = await projectDirectory(text(input.directory, 4000));
      if (this.projectBusy(projectId))
        throw new HttpError(409, "PAUSE_BEFORE_EDITING");
      this.settings.mappings = this.settings.mappings
        .filter((m) => m.projectId !== projectId)
        .concat({
          projectId,
          directory,
          accessMode: this.settings.mappings.find(
            (m) => m.projectId === projectId,
          )?.accessMode,
          model: this.settings.mappings.find((m) => m.projectId === projectId)
            ?.model,
          reasoningEffort: this.settings.mappings.find(
            (m) => m.projectId === projectId,
          )?.reasoningEffort,
          progressMode:
            input.progressMode === "manual" || input.progressMode === "auto"
              ? input.progressMode
              : this.settings.mappings.find((m) => m.projectId === projectId)
                  ?.progressMode,

          network: input.network === true,
          slots: Math.max(1, Math.min(8, Number(input.slots) || 1)),
        });
      await this.save();
      if (input.allow === true) this.allowedProjects.add(projectId);
      else if (input.allow === false) this.allowedProjects.delete(projectId);
      if (typeof input.allow === "boolean")
        this.settings.slots = Math.min(
          8,
          Math.max(
            1,
            this.executionMappings().reduce(
              (total, mapping) => total + mapping.slots,
              0,
            ),
          ),
        );
      this.ready();
      break;
    }
    case "/api/allow": {
      const projectId = id(input.projectId);
      const mapping = this.settings.mappings.find(
        (m) => m.projectId === projectId,
      );
      if (!mapping || !this.settings.projects.some((p) => p.id === projectId))
        throw new HttpError(409, "PROJECT_DIRECTORY_REQUIRED");
      mapping.slots = Math.max(
        1,
        Math.min(8, Number(input.slots) || mapping.slots),
      );
      if (input.allow === true) this.allowedProjects.add(projectId);
      else this.allowedProjects.delete(projectId);
      this.settings.slots = Math.min(
        8,
        Math.max(
          1,
          this.executionMappings().reduce((total, m) => total + m.slots, 0),
        ),
      );
      await this.save();
      this.ready();
      break;
    }
    case "/api/approval":
      this.executor.approve(id(input.id), input.allow === true);
      break;
    case "/api/codex/doctor":
      await this.checkAccount();
      break;
    case "/api/codex/login": {
      startLogin(this);
      break;
    }
    case "/api/stop": {
      const value = this.executor.runs[id(input.runId)];
      if (!value || this.executor.deletedTasks[value.task.id])
        throw new Error("RUN_NOT_FOUND");
      await this.executor.receive(
        {
          v: 1,
          type: "stop",
          id: randomUUID(),
          runId: value.task.runId,
          taskId: value.task.id,
        },
        this.executionMappings(),
        this.allow,
        this.settings.slots,
        value.origin === "local"
          ? { progressMode: value.progressMode ?? "auto" }
          : undefined,
      );
      break;
    }
    case "/api/progress-mode": {
      if (!["auto", "manual"].includes(String(input.mode)))
        throw new HttpError(400, "INVALID_PROGRESS_MODE");
      if (input.runId) {
        const value = this.executor.runs[id(input.runId)];
        if (!value || this.executor.deletedTasks[value.task.id])
          throw new HttpError(404, "RUN_NOT_FOUND");
        const mode = input.mode as "auto" | "manual";
        if (this.executor.active.has(value.task.runId)) {
          value.pendingProgressMode =
            mode === (value.progressMode ?? "auto") ? undefined : mode;
        } else {
          value.progressMode = mode;
          value.pendingProgressMode = undefined;
          if (mode === "manual") value.planApproved = false;
        }
        await this.executor.save();
        break;
      }
      const projectId = id(input.projectId);
      if (!this.settings.projects.some((p) => p.id === projectId))
        throw new HttpError(400, "UNKNOWN_PROJECT");
      const mapping = this.settings.mappings.find(
        (m) => m.projectId === projectId,
      );
      if (!mapping) throw new HttpError(409, "PROJECT_DIRECTORY_REQUIRED");
      if (
        input.accessMode !== undefined &&
        !["full", "approval"].includes(String(input.accessMode))
      )
        throw new HttpError(400, "INVALID_ACCESS_MODE");
      mapping.progressMode = input.mode as "auto" | "manual";
      if (input.accessMode !== undefined) {
        mapping.accessMode =
          input.mode === "auto"
            ? "full"
            : (input.accessMode as "full" | "approval");
        mapping.network = true;
      }
      await this.save();
      break;
    }
    case "/api/execute-plan": {
      const value = this.executor.runs[id(input.runId)];
      if (value?.origin === "local") {
        await this.executor.startPlannedWork(value.task.runId);
        break;
      }
      if (!this.allow || !this.connected)
        throw new HttpError(409, "EXECUTION_NOT_ALLOWED");
      if (
        !value ||
        !this.settings.mappings.some(
          (mapping) =>
            mapping.projectId === value.task.projectId &&
            this.allowedProjects.has(mapping.projectId) &&
            (!value.task.network || mapping.network),
        )
      )
        throw new HttpError(409, "MAPPING_REQUIRED");
      await this.executor.startPlannedWork(value.task.runId);
      break;
    }
    case "/api/continue": {
      const value = this.executor.runs[id(input.runId)];
      if (!value || this.executor.deletedTasks[value.task.id])
        throw new HttpError(404, "RUN_NOT_FOUND");
      const requestKey = id(input.requestKey),
        instruction = text(input.instruction, 8000);
      let receipt;
      if (value.origin === "local")
        receipt = await continueLocalTask(
          this,
          value.task.runId,
          requestKey,
          instruction,
          Number(input.revision),
        );
      else {
        if (!this.continuationSupported)
          throw new HttpError(409, "CONTINUATION_UNSUPPORTED");
        receipt = await this.workspaceRequest("task.continue", {
          taskId: value.task.id,
          requestId: requestKey,
          text: instruction,
          revision: input.revision,
        });
      }
      send(res, 200, { ok: true, receipt });
      return;
    }
    case "/api/instruction": {
      const handler =
        this.executor.runs[id(input.runId)]?.origin === "local"
          ? (runId: string, key: string, instruction: string) =>
              localInstruction(this, runId, key, instruction)
          : this.control;
      const receipt = await handler(
        id(input.runId),
        id(input.requestKey),
        text(input.instruction, 8000),
      );
      send(res, 200, { ok: true, receipt });
      return;
    }
    case "/api/diff": {
      const value = this.executor.runs[id(input.runId)];
      if (!value || this.executor.deletedTasks[value.task.id])
        throw new HttpError(404, "RUN_NOT_FOUND");
      const artifact = await this.executor.artifact(value.task.runId);
      send(res, 200, { patch: activityText(artifact.patch, 256000) });
      return;
    }
    case "/api/preview": {
      const value = this.executor.runs[id(input.runId)];
      if (!value || this.executor.deletedTasks[value.task.id])
        throw new Error("RUN_NOT_FOUND");
      if (value.origin === "local")
        throw new HttpError(409, "LOCAL_SHARING_NOT_CONNECTED");
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
      this.preview.register(previewId, port, value.task.id);
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
