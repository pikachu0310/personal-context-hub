import { WorkspaceLifecycle } from "../processing/projects/lifecycle.js";
import { seedParticipants } from "../processing/projects/task-participants.js";
import type { Task } from "@ido/common/contracts/protocol";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { RELEASE } from "@ido/common/contracts/protocol";
import { Credentials } from "@ido/common/runtime/credentials";
import { HttpError, RateLimit, send } from "@ido/common/runtime/http";
import { ClientConnections } from "../adapters/client-ws/connections.js";
import { route } from "../adapters/http/admin.js";
import {
  authenticate,
  config,
  mutate,
  trustedHost,
} from "../adapters/http/auth.js";
import { OpenAIModels } from "../adapters/openai/models.js";
import { PluginBroker } from "../adapters/plugins/broker.js";
import { Plugins, type CatalogEntry } from "../adapters/plugins/host.js";
import { Store } from "../adapters/sqlite/store.js";
import { Tunnels } from "../adapters/tunnels/manager.js";
import { Workspace } from "../output/queries/workspace.js";
import { TaskEvents } from "../output/text/task-events.js";
import { Conversation } from "../processing/conversation.js";
import { InputRouter } from "../processing/routing/input.js";
import { CoordinatedConversation } from "../processing/coordinator/session.js";
import { createWorkPort } from "../processing/tasks/work.js";
import { createOpenAICoordinatorFactory } from "../adapters/openai/coordinator.js";
import { createLiveSession } from "../adapters/openai/live.mjs";
import type { CoordinatorFactory } from "../ports/coordinator.js";
import type { ConversationMode } from "@ido/common/contracts/coordinator";
import { Projects } from "../processing/projects/service.js";
export interface EngineOptions {
  directory: string;
  port?: number;
  previewPort?: number;
  host?: string;
  uiDirectory?: string;
  dashboardEntry?: string;
  pluginCatalog?: CatalogEntry[];
  conversation?:
    | false
    | {
        mode?: ConversationMode;
        coordinator?: CoordinatorFactory;
        observationIntervalMs?: number;
        createLiveSession?: any;
        model?: string;
      };
}
export class Engine {
  readonly store: Store;
  readonly credentials: Credentials;
  readonly plugins: Plugins;
  readonly broker: PluginBroker;
  readonly conversation: Conversation;
  readonly input: InputRouter;
  readonly connections: ClientConnections;
  readonly workspace: Workspace;
  readonly taskEvents: TaskEvents;
  readonly coordinatorFactory?: CoordinatorFactory & {
    close?(): Promise<void>;
  };
  readonly tunnels: Tunnels;
  readonly loginLimit = new RateLimit(10, 60000);
  readonly pairLimit = new RateLimit(20, 60000);
  origin: string;
  previewOrigin: string;
  ui: string;
  timer?: NodeJS.Timeout;
  readonly config = config.bind(this);
  readonly trustedHost = trustedHost.bind(this);
  readonly authenticate = authenticate.bind(this);
  readonly mutate = mutate.bind(this);
  readonly route = route.bind(this);
  readonly server = createServer((req, res) => {
    void this.route(req, res).catch((error) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      const message =
        error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
          ? error.message
          : "REQUEST_FAILED";
      send(res, error instanceof HttpError ? error.status : 400, {
        error: message,
      });
    });
  });
  readonly wss = new WebSocketServer({
    noServer: true,
    maxPayload: 3 * 1024 * 1024,
    perMessageDeflate: false,
  });
  constructor(readonly options: EngineOptions) {
    this.store = new Store(options.directory);
    new Projects(this.store).ensure();
    for (const entry of this.store.entries())
      if (entry.kind === "project-lock")
        this.store.remove(entry.kind, entry.id);
    for (const task of this.store.list<Task>("task")) {
      if (!task.memberStates) {
        seedParticipants(this.store, task);
        this.store.put("task", task.id, task);
      }
    }
    this.credentials = new Credentials(options.directory, "ido-engine");
    this.origin = `http://127.0.0.1:${options.port ?? 4310}`;
    this.previewOrigin = `http://127.0.0.1:${options.previewPort ?? 4311}`;
    this.ui =
      options.uiDirectory ??
      join(dirname(fileURLToPath(import.meta.url)), "ui");
    this.conversation = new Conversation(
      this.store,
      new OpenAIModels(this.credentials),
    );
    this.connections = new ClientConnections(
      this.store,
      () => {
        this.taskEvents.flush();
        this.connections.broadcastProjects();
      },
      () =>
        [...this.plugins.processes.values()].flatMap((plugin) =>
          plugin.running ? (plugin.manifest?.web?.frameAncestors ?? []) : [],
        ),
    );
    this.input = new InputRouter(this.store, this.conversation, () =>
      this.flush(),
    );
    this.workspace = new Workspace(
      this.store,
      this.tasks,
      this.input,
      () => this.flush(),
      (taskId) => this.connections.artifact(taskId),
      (taskId, userId) =>
        (this.config().engineUrl ?? this.origin) +
        this.preview.ticket(taskId, userId),
    );
    this.broker = new PluginBroker(
      this.store,
      () => this.plugins,
      this.input,
      this.workspace,
      () => this.config().engineUrl ?? this.origin,
    );
    const bundled = join(
      dirname(fileURLToPath(import.meta.url)),
      "plugins",
      "dashboard",
      "index.js",
    );
    const local = fileURLToPath(
      new URL("../../../plugin-dashboard/dist/index.js", import.meta.url),
    );
    this.plugins = new Plugins(
      options.directory,
      this.store,
      this.credentials,
      [
        {
          id: "dashboard",
          package: "@ido/plugin-dashboard",
          version: RELEASE,
          builtin:
            options.dashboardEntry ?? (existsSync(bundled) ? bundled : local),
        },
        { id: "discord", package: "@ido/plugin-discord", version: RELEASE },
        ...(options.pluginCatalog ?? []),
      ],
      (id, op, input, context) => this.broker.request(id, op, input, context),
      () => {},
    );
    this.taskEvents = new TaskEvents(this.store, (event) => {
      this.plugins.publish(event);
      if (event.type === "tasks")
        void this.conversation.coordinated
          ?.taskEvents(event.data as any)
          .catch((error) =>
            this.store.logError(error, {
              source: "conversation",
              operation: "task.result",
            }),
          );
    });
    this.connections.onImplementationChanged = (meetingId) => {
      void this.conversation.document.refresh(meetingId);
    };
    if (options.conversation !== false) {
      const conversation = options.conversation ?? {};
      this.coordinatorFactory =
        conversation.coordinator ??
        createOpenAICoordinatorFactory({
          credentials: this.credentials,
          model: conversation.model,
        });
      this.conversation.coordinated = new CoordinatedConversation(this.store, {
        coordinator: this.coordinatorFactory,
        updateMinutes: (meetingId) =>
          this.conversation.document.refresh(meetingId),
        work: createWorkPort({
          repository: this.store,
          tasks: this.tasks,
          onChange: () => this.flush(),
        }),
        synthesize: (text) => this.conversation.speak(text),
        createLiveSession:
          conversation.createLiveSession ??
          (async (settings: Record<string, unknown>) => {
            const apiKey = await this.credentials.get("openai");
            if (!apiKey) throw new Error("OPENAI_KEY_REQUIRED");
            return createLiveSession({ ...settings, apiKey });
          }),
        mode: conversation.mode,
        observationIntervalMs: conversation.observationIntervalMs,
        publish: (event) => this.plugins.publish(event),
      });
    }
    const lifecycle = new WorkspaceLifecycle(
      this.store,
      async (projectId) => {
        await this.conversation.coordinated?.resetProject(projectId);
      },
      (task) => this.connections.invalidateTask(task),
    );
    this.connections.lifecycle = lifecycle;
    this.workspace.lifecycle = lifecycle;
    this.workspace.conversationBindings = () =>
      this.plugins.conversationBindings();
    this.workspace.engineUrl = () => this.config().engineUrl ?? this.origin;
    this.tunnels = new Tunnels(options.directory, this.store, this.credentials);
    this.server.on("upgrade", (req, socket, head) => {
      if (req.url?.startsWith("/preview/") && this.trustedHost(req)) {
        this.preview.server.emit("upgrade", req, socket, head);
        return;
      }
      if (
        req.url !== "/connect" ||
        req.headers.origin ||
        !this.trustedHost(req)
      ) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) =>
        this.connections.connect(ws),
      );
    });
  }
  get tasks() {
    return this.connections.tasks;
  }
  get scheduler() {
    return this.connections.scheduler;
  }
  get peers() {
    return this.connections.peers;
  }
  get ready() {
    return this.connections.ready;
  }
  get preview() {
    return this.connections.preview;
  }
  get contexts() {
    return this.broker.contexts;
  }
  flush() {
    this.connections.broadcastProjects();
    this.connections.flush();
    this.taskEvents.flush();
  }
  async listen() {
    if (!this.store.users().length)
      throw new Error("Run ido-engine init before starting the server");
    for (const entry of this.plugins.catalog) {
      try {
        await this.plugins.inspect(entry.id);
      } catch {
        /* Optional plugin is not installed. */
      }
    }
    try {
      await this.plugins.start("dashboard");
    } catch (error) {
      this.store.logError(error, {
        source: "plugin",
        operation: "dashboard.start",
      });
    }
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(
        this.options.port ?? 4310,
        this.options.host ?? "127.0.0.1",
        resolve,
      );
    });
    const address = this.server.address();
    if (address && typeof address !== "string")
      this.origin = `http://127.0.0.1:${address.port}`;
    await new Promise<void>((resolve, reject) => {
      this.preview.server.once("error", reject);
      this.preview.server.listen(
        this.options.previewPort ?? 4311,
        this.options.host ?? "127.0.0.1",
        resolve,
      );
    });
    const previewAddress = this.preview.server.address();
    if (previewAddress && typeof previewAddress !== "string")
      this.previewOrigin = `http://127.0.0.1:${previewAddress.port}`;
    this.timer = setInterval(() => {
      this.flush();
      for (const ws of this.peers.values()) {
        const peer = ws as typeof ws & { alive?: boolean };
        if (peer.alive === false) peer.terminate();
        else {
          peer.alive = false;
          peer.ping();
        }
      }
    }, 15000);
    return this;
  }
  async close() {
    this.conversation.document.stop();
    clearInterval(this.timer);
    const inputs = this.input.close();
    await this.conversation.coordinated?.close();
    await inputs;
    await this.coordinatorFactory?.close?.();
    await this.plugins.close();
    this.tunnels.stop();
    this.connections.close();
    this.wss.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.store.close();
  }
}
