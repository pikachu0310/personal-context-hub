import { type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import {
  type Command,
  type Mapping,
  type Project,
  type Task,
} from "@ido/common/contracts/protocol";
import { Credentials } from "@ido/common/runtime/credentials";
import { HttpError, send } from "@ido/common/runtime/http";
import { atomic, hash, json, secret } from "@ido/common/runtime/platform";
import { restoreIdentity } from "../storage/identity.js";
import { syncLocalShares } from "../connection/local-sharing.js";
import { connect } from "../connection/engine.js";
import { control } from "../connection/control.js";
import type { WorkReceipt } from "@ido/common/contracts/work";
import type { TeamTaskSnapshot } from "@ido/common/contracts/api";
import { pair } from "../connection/pair.js";
import { pollPair } from "../connection/poll.js";
import { Executor } from "../execution/executor.js";
import { route } from "../http/routes.js";
import { agentCatalog } from "../agents/model-catalog.js";
import { ClientPreview } from "../preview/relay.js";

import { checkAccount } from "../auth/account.js";
import { workspaceRequest } from "../connection/workspace.js";
import { createProject } from "../connection/projects.js";
import { isUnrestrictedAccess } from "@ido/common/contracts/work";
interface Settings {
  pendingPair?: { id: string; engineUrl: string; expires: number };
  identityId?: string;
  profile?: { name: string; context: string; avatar?: string };
  pendingProject?: {
    requestId: string;
    name: string;
    directory: string;
    engineUrl?: string;
    deviceId?: string;
  };
  progressMode?: "auto" | "manual";
  engineUrl?: string;
  deviceId?: string;
  publicKey?: string;
  mappings: Mapping[];
  slots: number;
  projects: Project[];
}
export class Client {
  agentCatalog = async () => {
    const catalog = await agentCatalog(this.executor.home, this.directory);
    this.loginStatus = catalog.find((value) => value.agent === "codex")
      ?.authenticated
      ? "authenticated"
      : "login required";
    this.claudeLoginStatus = catalog.find((value) => value.agent === "claude")
      ?.authenticated
      ? "authenticated"
      : "not authenticated";
    if (!this.stopping) this.ready();
    return catalog;
  };
  settings: Settings = { mappings: [], slots: 1, projects: [] };
  credentials: Credentials;
  executor: Executor;
  preview: ClientPreview;
  csrf = secret();
  origin = "";
  generation = 0;
  connected = false;
  lifecycleSupported = false;
  controlSupported = false;
  continuationSupported = false;
  localSharingSupported = false;
  localSharingBusy = false;
  localSharingTimer?: NodeJS.Timeout;
  readonly syncLocalShares = syncLocalShares.bind(this);
  workspaceSupported = false;
  workspaceRequests = new Map<
    string,
    {
      resolve: (result: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  suggestedInvite?: { engineUrl: string; token: string };
  projectTasks: Task[] = [];
  projectCreationSupported = false;
  projectCreationBusy = false;
  projectRequests = new Map<
    string,
    {
      resolve: (project: Project) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  teamTasksSupported = false;
  teamTasks?: TeamTaskSnapshot;
  teamTasksRequestedAt = 0;
  controlRequests = new Map<
    string,
    {
      resolve: (receipt: WorkReceipt) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  readonly allowedProjects = new Set<string>();
  get allow() {
    return this.allowedProjects.size > 0;
  }
  syncProjects(projects: Project[], tasks?: Task[]) {
    const joined = new Set(projects.map((p) => p.id));
    for (const id of this.allowedProjects)
      if (!joined.has(id)) this.allowedProjects.delete(id);
    this.settings.projects = projects;
    if (tasks) this.projectTasks = tasks;
    else
      this.projectTasks = this.projectTasks.filter((t) =>
        joined.has(t.projectId),
      );
    if (this.teamTasks)
      this.teamTasks.tasks = this.teamTasks.tasks.filter(
        (t) =>
          joined.has(t.projectId) &&
          (!tasks || tasks.some((current) => current.id === t.id)),
      );
  }
  executionMappings() {
    return this.settings.mappings
      .filter(
        (m) =>
          this.allowedProjects.has(m.projectId) &&
          this.settings.projects.some((p) => p.id === m.projectId),
      )
      .map((mapping) => ({
        ...mapping,
        network: isUnrestrictedAccess(mapping.accessMode) || mapping.network,
      }));
  }
  projectBusy(projectId: string) {
    return (
      this.allowedProjects.has(projectId) ||
      [...this.executor.active.keys()].some(
        (runId) => this.executor.runs[runId]?.task.projectId === projectId,
      )
    );
  }
  stopping = false;
  ws?: WebSocket;
  reconnect?: NodeJS.Timeout;
  pairing?: { id: string; proof: string; url: string; fingerprint: string };
  pairTimer?: NodeJS.Timeout;
  pairRequest?: Promise<void>;
  pairStart?: Promise<void>;
  status = "offline";
  identityStatus = "not checked";
  login?: ChildProcess;
  loginStatus = "not checked";
  account?: import("@ido/common/contracts/api").ClientAccount;
  accountCheck?: Promise<void>;
  claudeLoginStatus = "not checked";
  claudeLoginUrl?: string;
  loginUrl?: string;
  suggestedEngine?: string;
  desktop?: { name: string; version: string; pid: number; platform: string };
  processing: Promise<unknown> = Promise.resolve();
  server = createServer(
    (req, res) =>
      void this.route(req, res).catch((e) => {
        if (!res.headersSent)
          send(res, e instanceof HttpError ? e.status : 400, {
            error: e instanceof HttpError ? e.message : "REQUEST_FAILED",
          });
      }),
  );
  constructor(
    readonly directory: string,
    readonly uiDirectory = join(dirname(fileURLToPath(import.meta.url)), "ui"),
  ) {
    this.credentials = new Credentials(directory, "ido-client");
    this.executor = new Executor(directory, (data) => this.emit(data));
    this.executor.knowledge = (task, input) =>
      this.workspaceRequest("task.knowledge", {
        ...input,
        taskId: task.id,
        runId: task.runId,
        revision: task.revision,
      });
    this.executor.contextProfile = () => this.settings.profile;
    this.preview = new ClientPreview((data) => this.emit(data));
  }
  async start(port = 4320) {
    this.settings = await json(
      join(this.directory, "client.json"),
      this.settings,
    );
    this.settings.profile ??= { name: "参加者", context: "" };
    this.allowedProjects.clear();
    for (const mapping of this.settings.mappings)
      if (
        mapping.executionAllowed === true &&
        this.settings.projects.some(
          (project) => project.id === mapping.projectId,
        )
      )
        this.allowedProjects.add(mapping.projectId);
    await this.executor.load();
    if (this.settings.progressMode) {
      for (const mapping of this.settings.mappings)
        mapping.progressMode ??= this.settings.progressMode;
      delete this.settings.progressMode;
      await this.save();
    }
    await restoreIdentity(this);
    if (this.settings.pendingPair) {
      const pending = this.settings.pendingPair;
      const proof = await this.credentials.get(`pair.${pending.id}`);
      if (pending.expires > Date.now() && proof) {
        this.pairing = {
          id: pending.id,
          proof,
          url: `${pending.engineUrl}/admin/pair/${pending.id}`,
          fingerprint: hash(this.settings.publicKey!),
        };
      } else {
        this.status = proof ? "pairing expired" : "pairing proof unavailable";
        if (pending.expires <= Date.now()) {
          delete this.settings.pendingPair;
          await this.save();
          await this.credentials.set(`pair.${pending.id}`, "");
        }
      }
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(port, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    this.origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : port}`;
    this.localSharingTimer = setInterval(
      () => void this.syncLocalShares(),
      5000,
    );
    this.localSharingTimer.unref();
    void this.checkAccount();
    if (this.pairing) this.pollPair();
    else if (this.settings.deviceId) void this.connect();
    return this;
  }
  private saving: Promise<void> = Promise.resolve();
  save() {
    for (const mapping of this.settings.mappings)
      mapping.executionAllowed = this.allowedProjects.has(mapping.projectId);
    const snapshot = structuredClone(this.settings);
    this.saving = this.saving
      .catch(() => {})
      .then(() => atomic(join(this.directory, "client.json"), snapshot));
    // Event-driven callers do not await save; retain the rejection for close()
    // while making failure visible without an unhandled promise rejection.
    void this.saving.catch(() => {
      this.status = "settings save failed";
    });
    return this.saving;
  }
  emit(data: Command) {
    if (this.ws?.readyState === WebSocket.OPEN && this.connected)
      this.ws.send(JSON.stringify({ ...data, generation: this.generation }));
  }
  grants() {
    return this.executionMappings().map(({ projectId, network, slots }) => ({
      projectId,
      network,
      slots,
    }));
  }
  ready() {
    this.emit({
      v: 1,
      type: "ready",
      executionPolicyVersion: 1,
      profile: {
        ...this.settings.profile,
        name: this.settings.profile?.name || "参加者",
        codexConnected: this.loginStatus === "authenticated",
      },
      grants: this.grants(),
      slots: this.settings.slots,
    });
  }
  readonly checkAccount = checkAccount.bind(this);
  workspaceRequest<T>(
    operation: string,
    input: Record<string, unknown>,
  ): Promise<T> {
    return workspaceRequest.call(this, operation, input) as Promise<T>;
  }
  readonly createProject = createProject.bind(this);
  readonly connect = connect.bind(this);
  readonly control = control.bind(this);
  readonly pair = pair.bind(this);
  readonly pollPair = pollPair.bind(this);
  readonly route = route.bind(this);
  async close() {
    this.stopping = true;
    clearInterval(this.localSharingTimer);
    clearTimeout(this.reconnect);
    clearTimeout(this.pairTimer);
    this.login?.kill();
    this.ws?.close();
    for (const request of this.controlRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new HttpError(409, "CONTROL_DELIVERY_UNKNOWN"));
    }
    this.controlRequests.clear();
    for (const request of this.workspaceRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new HttpError(409, "WORKSPACE_DELIVERY_UNKNOWN"));
    }
    this.workspaceRequests.clear();
    for (const request of this.projectRequests.values()) {
      clearTimeout(request.timer);
      request.reject(new HttpError(409, "PROJECT_DELIVERY_UNKNOWN"));
    }
    this.projectRequests.clear();
    this.preview.close();
    await this.pairStart?.catch(() => {});
    await this.pairRequest;
    await this.accountCheck;
    await this.processing.catch(() => {});
    await this.executor.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await this.saving;
  }
}
