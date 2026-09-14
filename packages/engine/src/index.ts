import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID, verify, createPublicKey } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, type Device, type Meeting } from "./store.js";
import { Plugins } from "./plugins.js";
import { Conversation } from "./ai.js";
import { PreviewRelay } from "./preview.js";
import { DiscordAuth } from "./discord-auth.js";
import { Tunnels } from "./tunnels.js";
import { Credentials } from "../../common/src/credentials.js";
import {
  body,
  send,
  headers,
  asset,
  HttpError,
  RateLimit,
} from "../../common/src/http.js";
import {
  secret,
  hash,
  equal,
  passwordMatches,
} from "../../common/src/platform.js";
import {
  frame,
  text,
  id,
  endpoint,
  type User,
  type Task,
  type Grant,
  type Command,
  type Project,
} from "../../common/src/protocol.js";

type Pair = {
  id: string;
  proof: string;
  publicKey: string;
  name: string;
  expires: number;
  userId?: string;
  deviceId?: string;
};
type Auth = { user: User; csrf: string; token: string };
export interface EngineOptions {
  directory: string;
  port?: number;
  previewPort?: number;
  host?: string;
  uiDirectory?: string;
}
export class Engine {
  store: Store;
  credentials: Credentials;
  plugins: Plugins;
  conversation: Conversation;
  preview: PreviewRelay;
  discordAuth: DiscordAuth;
  tunnels: Tunnels;
  artifactRequests = new Map<
    string,
    {
      deviceId: string;
      runId: string;
      revision: number;
      resolve: (data: Command) => void;
      timer: NodeJS.Timeout;
    }
  >();
  peers = new Map<string, WebSocket>();
  ready = new Set<string>();
  loginLimit = new RateLimit(10, 60000);
  pairLimit = new RateLimit(20, 60000);
  origin: string;
  previewOrigin: string;
  ui: string;
  server = createServer((req, res) => {
    void this.route(req, res).catch((e) => {
      if (!res.headersSent)
        send(res, e instanceof HttpError ? e.status : 400, {
          error: e instanceof HttpError ? e.message : "REQUEST_FAILED",
        });
      else res.end();
    });
  });
  wss = new WebSocketServer({
    noServer: true,
    maxPayload: 3 * 1024 * 1024,
    perMessageDeflate: false,
  });
  timer?: NodeJS.Timeout;
  constructor(readonly options: EngineOptions) {
    this.store = new Store(options.directory);
    this.credentials = new Credentials(options.directory, "ido-engine");
    this.discordAuth = new DiscordAuth(
      this.store,
      this.credentials,
      (operation, input) => this.plugins.request(operation, input),
    );
    this.tunnels = new Tunnels(options.directory, this.store, this.credentials);
    this.origin = `http://127.0.0.1:${options.port ?? 4310}`;
    this.previewOrigin = `http://127.0.0.1:${options.previewPort ?? 4311}`;
    this.ui =
      options.uiDirectory ??
      join(dirname(fileURLToPath(import.meta.url)), "ui");
    this.conversation = new Conversation(this.store, this.credentials);
    this.plugins = new Plugins(
      options.directory,
      this.store,
      this.credentials,
      (event) => this.pluginInput(event),
    );
    this.preview = new PreviewRelay(this.store, (id) =>
      this.ready.has(id) ? this.peers.get(id) : undefined,
    );
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
      this.wss.handleUpgrade(req, socket, head, (ws) => this.connect(ws));
    });
  }
  config() {
    return this.store.get<Record<string, string>>("config", "public") ?? {};
  }
  trustedHost(req: IncomingMessage) {
    const remote = this.config().engineUrl;
    const local =
      req.headers.host === new URL(this.origin).host &&
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress ?? "",
      );
    if (local && !req.headers["x-forwarded-host"]) return true;
    // Remote requests must arrive through a local HTTPS reverse proxy. Headers from remote sockets are never trusted.
    return Boolean(
      remote &&
      ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
        req.socket.remoteAddress ?? "",
      ) &&
      req.headers.host === new URL(remote).host &&
      req.headers["x-forwarded-proto"] === "https",
    );
  }
  async listen() {
    if (!this.store.users().length)
      throw new Error("Run ido-engine init before starting the server");
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
        if ((ws as WebSocket & { alive?: boolean }).alive === false)
          ws.terminate();
        else {
          (ws as WebSocket & { alive?: boolean }).alive = false;
          ws.ping();
        }
      }
    }, 15000);
    return this;
  }
  authenticate(req: IncomingMessage): Auth {
    const token =
      (req.headers.cookie ?? "")
        .split(";")
        .map((x) => x.trim())
        .find((x) => x.startsWith("ido_session="))
        ?.slice(12) ?? "";
    const row = this.store.db
      .prepare("SELECT userId,csrf FROM sessions WHERE token=? AND expires>?")
      .get(hash(token), Date.now());
    const user = row && this.store.user(row.userId as string);
    if (!user) throw new HttpError(401, "LOGIN_REQUIRED");
    return { user, csrf: row!.csrf as string, token };
  }
  mutate(req: IncomingMessage, auth: Auth, admin = false) {
    if (!equal(String(req.headers["x-csrf-token"] ?? ""), auth.csrf))
      throw new HttpError(403, "CSRF_REQUIRED");
    if (auth.user.role === "viewer" || (admin && auth.user.role !== "admin"))
      throw new HttpError(403, "PERMISSION_DENIED");
  }
  async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", this.origin);
    if (!this.trustedHost(req))
      throw new HttpError(403, "HTTPS_PROXY_OR_LOCALHOST_REQUIRED");
    // Preview requests use a scoped capability, never the management session.
    // Opaque sandbox origins must reach the relay but cannot reach management APIs.
    if (url.pathname === "/preview" || url.pathname.startsWith("/preview/")) {
      await this.preview.http(req, res);
      return;
    }
    headers(
      res,
      url.pathname.startsWith("/activity") || url.searchParams.has("frame_id"),
    );
    const requestOrigin = req.headers.origin;
    const expected =
      req.headers.host === new URL(this.origin).host
        ? this.origin
        : this.config().engineUrl;
    const activityRequest = url.pathname.startsWith("/api/activity/");
    const activityOrigin = `https://${this.discordAuth.config().appId}.discordsays.com`;
    if (
      requestOrigin &&
      requestOrigin !== expected &&
      !(activityRequest && requestOrigin === activityOrigin)
    )
      throw new HttpError(403, "ORIGIN_DENIED");
    if (url.pathname === "/health") {
      send(res, 200, { ok: true, service: "ido-engine", protocol: 1 });
      return;
    }
    if (!url.pathname.startsWith("/api/")) {
      await asset(req, res, this.ui, url.pathname);
      return;
    }
    if (url.pathname === "/api/discord/callback" && req.method === "GET") {
      await this.discordAuth.callback(
        url.searchParams.get("state") ?? "",
        url.searchParams.get("code") ?? "",
        expected!,
      );
      res.writeHead(302, { Location: "/" });
      res.end();
      return;
    }
    if (activityRequest) {
      if (url.pathname === "/api/activity/config" && req.method === "GET") {
        send(res, 200, { appId: this.discordAuth.config().appId });
        return;
      }
      if (url.pathname === "/api/activity/auth" && req.method === "POST") {
        this.pairLimit.take(req.socket.remoteAddress ?? "");
        send(
          res,
          200,
          await this.discordAuth.activity(text((await body(req)).code, 4000)),
        );
        return;
      }
      const user = this.discordAuth.user(
        (req.headers.authorization ?? "").replace(/^Bearer /, ""),
      );
      if (url.pathname === "/api/activity/state" && req.method === "GET") {
        send(res, 200, {
          user,
          meetings: this.store.list("meeting"),
          tasks: this.store.list("task"),
          projects: this.store.list("project"),
        });
        return;
      }
      if (req.method !== "POST") throw new HttpError(404, "NOT_FOUND");
      const input = await body(req);
      if (url.pathname === "/api/activity/preview") {
        send(res, 200, { url: this.preview.ticket(id(input.taskId), user.id) });
        return;
      }
      if (user.role === "viewer") throw new HttpError(403, "PERMISSION_DENIED");
      if (url.pathname === "/api/activity/control") {
        if (!["stop", "steer"].includes(String(input.action)))
          throw new HttpError(400, "INVALID_ACTION");
        this.store.control(
          id(input.taskId),
          user.id,
          input.action as "stop" | "steer",
          input.text ? text(input.text) : undefined,
        );
        this.flush();
        send(res, 200, { ok: true });
        return;
      }
      if (url.pathname === "/api/activity/message") {
        void this.conversation
          .process(id(input.meetingId), user.id, text(input.text))
          .catch(() => {});
        send(res, 200, { ok: true });
        return;
      }
      throw new HttpError(404, "NOT_FOUND");
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
      if (!this.loginLimit.take(req.socket.remoteAddress ?? ""))
        throw new HttpError(429, "TRY_LATER");
      const input = await body(req);
      const name = text(input.name, 100),
        password = text(input.password, 1024);
      const row = this.store.db
        .prepare("SELECT * FROM users WHERE name=?")
        .get(name);
      if (!passwordMatches(password, String(row?.password ?? "invalid:00")))
        throw new HttpError(401, "INVALID_LOGIN");
      const session = this.store.session(String(row!.id));
      const secure = expected?.startsWith("https:");
      res.setHeader(
        "Set-Cookie",
        `ido_session=${session.token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${secure ? "; Secure" : ""}`,
      );
      send(res, 200, { csrf: session.csrf });
      return;
    }
    if (url.pathname === "/api/pair/request" && req.method === "POST") {
      if (
        req.headers.origin ||
        !this.pairLimit.take(req.socket.remoteAddress ?? "")
      )
        throw new HttpError(429, "PAIR_RATE_LIMIT");
      const input = await body(req);
      const publicKey = text(input.publicKey, 2000);
      if (createPublicKey(publicKey).asymmetricKeyType !== "ed25519")
        throw new HttpError(400, "INVALID_KEY");
      const proof = secret(),
        pair: Pair = {
          id: randomUUID(),
          proof: hash(proof),
          publicKey,
          name: text(input.name, 100),
          expires: Date.now() + 5 * 60000,
        };
      for (const old of this.store.list<Pair>("pair"))
        if (old.expires < Date.now()) this.store.remove("pair", old.id);
      this.store.put("pair", pair.id, pair);
      send(res, 201, {
        id: pair.id,
        proof,
        expires: pair.expires,
        url: `${expected}/pair/${pair.id}`,
      });
      return;
    }
    if (url.pathname === "/api/pair/poll" && req.method === "POST") {
      if (req.headers.origin) throw new HttpError(403, "CLIENT_ONLY");
      const input = await body(req);
      const pair = this.store.get<Pair>("pair", id(input.id));
      if (
        !pair ||
        pair.expires < Date.now() ||
        !equal(pair.proof, hash(text(input.proof)))
      )
        throw new HttpError(410, "PAIR_EXPIRED");
      if (!pair.userId) {
        send(res, 200, { pending: true });
        return;
      }
      const device: Device = {
        id: randomUUID(),
        userId: pair.userId,
        name: pair.name,
        publicKey: pair.publicKey,
        revoked: false,
        generation: 0,
        grants: [],
        slots: 1,
        lastAssigned: 0,
      };
      this.store.transaction(() => {
        this.store.put("device", device.id, device);
        this.store.remove("pair", pair.id);
      });
      send(res, 200, {
        deviceId: device.id,
        projects: this.store.list("project"),
      });
      return;
    }
    const auth = this.authenticate(req);
    const admin = auth.user.role === "admin";
    if (req.method !== "GET") {
      if (
        url.pathname === "/api/artifact" ||
        url.pathname === "/api/preview" ||
        url.pathname === "/api/logout" ||
        url.pathname === "/api/discord/link"
      ) {
        if (!equal(String(req.headers["x-csrf-token"] ?? ""), auth.csrf))
          throw new HttpError(403, "CSRF_REQUIRED");
      } else this.mutate(req, auth);
    }
    if (url.pathname === "/api/state" && req.method === "GET") {
      send(res, 200, {
        mode: "engine",
        user: auth.user,
        csrf: auth.csrf,
        projects: this.store.list("project"),
        meetings: this.store.list("meeting"),
        tasks: this.store.list("task"),
        clients: this.store
          .list<Device>("device")
          .map(({ publicKey, ...d }) => ({
            ...d,
            connected: this.ready.has(d.id),
          })),
        plugins: this.plugins.state(),
        tunnels: {
          status: this.tunnels.status,
          installed: this.store.list("tunnel"),
          busy: this.tunnels.busy || this.tunnels.starting,
          error: this.tunnels.error,
        },
        config: admin ? this.config() : {},
        discord: admin ? this.store.get("config", "discord") : {},
        users: admin ? this.store.users() : [],
        audit: admin ? this.store.events() : [],
        secrets: admin
          ? {
              openai: !!(await this.credentials.get("openai")),
              botToken: !!(await this.credentials.get("discord.botToken")),
              clientSecret: !!(await this.credentials.get(
                "discord.clientSecret",
              )),
            }
          : {},
      });
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/pair/")) {
      const pair = this.store.get<Pair>(
        "pair",
        id(url.pathname.split("/").at(-1)),
      );
      if (!pair || pair.expires < Date.now())
        throw new HttpError(410, "PAIR_EXPIRED");
      send(res, 200, {
        id: pair.id,
        name: pair.name,
        fingerprint: hash(pair.publicKey),
        expires: pair.expires,
      });
      return;
    }
    if (req.method !== "POST") throw new HttpError(404, "NOT_FOUND");
    const input = await body(req);
    switch (url.pathname) {
      case "/api/discord/link":
        send(res, 200, {
          url: this.discordAuth.start(
            auth.user.id,
            this.config().engineUrl ?? expected!,
          ),
        });
        return;
      case "/api/logout":
        this.store.db
          .prepare("DELETE FROM sessions WHERE token=?")
          .run(hash(auth.token));
        res.setHeader(
          "Set-Cookie",
          "ido_session=; Path=/; HttpOnly; Max-Age=0",
        );
        break;
      case "/api/pair/approve": {
        const pair = this.store.get<Pair>("pair", id(input.id));
        if (!pair || pair.userId || pair.expires < Date.now())
          throw new HttpError(410, "PAIR_EXPIRED");
        pair.userId = auth.user.id;
        this.store.put("pair", pair.id, pair);
        this.store.audit(auth.user.id, "device.approve", pair.id);
        break;
      }
      case "/api/projects": {
        this.mutate(req, auth, true);
        const project = {
          id: randomUUID(),
          name: text(input.name, 100),
          remote:
            typeof input.remote === "string" ? input.remote.slice(0, 2000) : "",
        };
        this.store.put("project", project.id, project);
        break;
      }
      case "/api/meetings": {
        const meeting: Meeting = {
          id: randomUUID(),
          name: text(input.name, 100),
          projectId: input.projectId ? id(input.projectId) : undefined,
          summary: "",
          messages: [],
        };
        this.store.put("meeting", meeting.id, meeting);
        break;
      }
      case "/api/messages": {
        const meetingId = id(input.meetingId);
        if (!this.store.get("meeting", meetingId))
          throw new HttpError(404, "MEETING_NOT_FOUND");
        void this.conversation
          .process(meetingId, auth.user.id, text(input.text))
          .catch(() => {});
        break;
      }
      case "/api/tasks": {
        const task = this.store.createTask({
          projectId: id(input.projectId),
          meetingId: id(input.meetingId),
          authorId: auth.user.id,
          text: text(input.text),
          requestId: id(input.requestId),
          network: input.network === true,
        });
        this.flush();
        send(res, 201, task);
        return;
      }
      case "/api/task/control": {
        if (!["stop", "steer", "retry"].includes(String(input.action)))
          throw new HttpError(400, "INVALID_ACTION");
        this.store.control(
          id(input.taskId),
          auth.user.id,
          input.action as "stop" | "steer" | "retry",
          input.text ? text(input.text) : undefined,
        );
        this.flush();
        break;
      }
      case "/api/artifact": {
        const task = this.store.get<Task>("task", id(input.taskId));
        const device =
          task?.clientId && this.store.get<Device>("device", task.clientId);
        const socket = task?.clientId && this.peers.get(task.clientId);
        if (!task || !device || !socket || !this.ready.has(device.id))
          throw new HttpError(409, "CLIENT_OFFLINE");
        const requestId = randomUUID();
        const artifact = await new Promise<Command>((resolve, reject) => {
          const timer = setTimeout(() => {
            this.artifactRequests.delete(requestId);
            reject(new HttpError(504, "ARTIFACT_TIMEOUT"));
          }, 15000);
          this.artifactRequests.set(requestId, {
            deviceId: device.id,
            runId: task.runId,
            revision: task.revision,
            resolve,
            timer,
          });
          socket.send(
            JSON.stringify({
              v: 1,
              type: "artifact.request",
              requestId,
              taskId: task.id,
              runId: task.runId,
              revision: task.revision,
              generation: device.generation,
            }),
          );
        });
        send(res, 200, {
          patch: artifact.patch,
          branch: artifact.branch,
          revision: artifact.revision,
          error: artifact.error,
        });
        return;
      }
      case "/api/preview": {
        const path = this.preview.ticket(id(input.taskId), auth.user.id);
        send(res, 200, {
          url: (this.config().engineUrl ?? this.origin) + path,
        });
        return;
      }
      case "/api/users":
        this.mutate(req, auth, true);
        if (!["admin", "member", "viewer"].includes(String(input.role)))
          throw new HttpError(400, "INVALID_ROLE");
        this.store.createUser(
          text(input.name, 100),
          text(input.password, 1024),
          input.role as User["role"],
        );
        break;
      case "/api/users/role": {
        this.mutate(req, auth, true);
        const userId = id(input.userId);
        if (
          userId === auth.user.id ||
          !["admin", "member", "viewer"].includes(String(input.role))
        )
          throw new HttpError(400, "INVALID_ROLE_CHANGE");
        this.store.db
          .prepare("UPDATE users SET role=? WHERE id=?")
          .run(String(input.role), userId);
        this.store.db
          .prepare("DELETE FROM sessions WHERE userId=?")
          .run(userId);
        for (const device of this.store
          .list<Device>("device")
          .filter((d) => d.userId === userId)) {
          this.ready.delete(device.id);
          this.peers.get(device.id)?.close(4003, "permissions changed");
        }
        this.store.audit(auth.user.id, "user.role", userId);
        break;
      }
      case "/api/devices/revoke": {
        const device = this.store.get<Device>("device", id(input.deviceId));
        if (!device || (device.userId !== auth.user.id && !admin))
          throw new HttpError(403, "PERMISSION_DENIED");
        device.revoked = true;
        this.store.put("device", device.id, device);
        this.ready.delete(device.id);
        this.peers.get(device.id)?.close(4003, "revoked");
        this.store.audit(auth.user.id, "device.revoke", device.id);
        break;
      }
      case "/api/settings": {
        this.mutate(req, auth, true);
        for (const field of ["openai", "botToken", "clientSecret"])
          if (typeof input[field] === "string" && input[field])
            await this.credentials.set(
              field === "openai" ? field : `discord.${field}`,
              text(input[field], 4000),
            );
        if (input.discord && typeof input.discord === "object") {
          const config: Record<string, string> = {};
          for (const key of [
            "guildId",
            "textChannelId",
            "appId",
            "projectId",
            "meetingId",
          ])
            if (input.discord[key]) config[key] = id(input.discord[key]);
          this.store.put("config", "discord", config);
        }
        this.store.audit(auth.user.id, "settings.update", "configuration");
        break;
      }
      case "/api/public": {
        this.mutate(req, auth, true);
        const engineUrl = endpoint(input.engineUrl).origin;
        if (!engineUrl.startsWith("https:"))
          throw new HttpError(400, "PUBLIC_HTTPS_REQUIRED");
        if (!["ngrok", "cloudflare", "manual"].includes(input.provider))
          throw new HttpError(400, "INVALID_PROVIDER");
        this.store.put("config", "public", {
          engineUrl,
          provider: text(input.provider, 30),
        });
        this.store.audit(auth.user.id, "public.update", "origins");
        break;
      }
      case "/api/doctor/openai":
        this.mutate(req, auth, true);
        send(res, 200, await this.conversation.doctor());
        return;
      case "/api/tunnels/install":
        this.mutate(req, auth, true);
        await this.tunnels.install(text(input.provider, 30));
        break;
      case "/api/tunnels/start":
        this.mutate(req, auth, true);
        if (input.token)
          await this.credentials.set(
            `tunnel.${text(input.provider, 30)}`,
            text(input.token, 8000),
          );
        await this.tunnels.start(
          text(input.provider, 30),
          { engine: Number(new URL(this.origin).port) },
          input.engineUrl ? text(input.engineUrl, 2048) : undefined,
        );
        break;
      case "/api/tunnels/stop":
        this.mutate(req, auth, true);
        this.tunnels.stop();
        break;
      case "/api/tunnels/doctor":
        this.mutate(req, auth, true);
        send(res, 200, await this.tunnels.diagnose());
        return;
      case "/api/plugins/install":
        this.mutate(req, auth, true);
        await this.plugins.install(text(input.version, 30));
        this.store.audit(auth.user.id, "plugin.install", "discord");
        break;
      case "/api/plugins/start":
        this.mutate(req, auth, true);
        await this.plugins.start();
        break;
      case "/api/plugins/stop":
        this.mutate(req, auth, true);
        this.plugins.stop();
        break;
      case "/api/discord/channels": {
        this.mutate(req, auth, true);
        const token = await this.credentials.get("discord.botToken");
        if (!token) throw new HttpError(400, "TOKEN_REQUIRED");
        const guildId = id(input.guildId);
        const response = await fetch(
          `https://discord.com/api/v10/guilds/${guildId}/channels`,
          {
            headers: { Authorization: `Bot ${token}` },
            signal: AbortSignal.timeout(15000),
          },
        );
        if (!response.ok) throw new HttpError(400, "DISCORD_DIAGNOSIS_FAILED");
        const channels = (await response.json()) as Array<{
          id: string;
          name: string;
          type: number;
        }>;
        send(res, 200, {
          channels: channels.map(({ id, name, type }) => ({ id, name, type })),
        });
        return;
      }
      default:
        throw new HttpError(404, "NOT_FOUND");
    }
    send(res, 200, { ok: true });
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
          this.store.updateResult(device.id, generation, data);
          this.flush();
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
    this.store.schedule(this.ready);
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
  async pluginInput(event: Record<string, unknown>) {
    const config = this.store.get<Record<string, string>>("config", "discord");
    if (
      !config ||
      event.guildId !== config.guildId ||
      (event.audio
        ? !this.plugins.voiceChannelId ||
          event.channelId !== this.plugins.voiceChannelId
        : event.channelId !== config.textChannelId)
    )
      return;
    const identity = this.store.get<{ userId: string }>(
      "discord-user",
      String(event.userId),
    );
    if (!identity || !this.store.user(identity.userId)) return;
    if (this.store.get("input", String(event.eventId))) return;
    this.store.put("input", String(event.eventId), {
      id: String(event.eventId),
      stage: event.audio ? "transcribing" : "accepted",
      at: Date.now(),
      meetingId: config.meetingId,
    });
    let content = typeof event.text === "string" ? text(event.text) : "";
    if (event.audio && typeof event.audio === "string")
      content = await this.conversation.transcribe(
        Buffer.from(event.audio, "base64"),
      );
    if (!content) return;
    const meeting = await this.conversation.process(
      config.meetingId,
      identity.userId,
      content,
      event.command === "task" ? null : config.projectId,
    );
    if (
      event.command === "task" &&
      this.store.user(identity.userId)?.role !== "viewer"
    ) {
      this.store.createTask({
        projectId: config.projectId,
        meetingId: config.meetingId,
        authorId: identity.userId,
        requestId: id(event.eventId),
        text: content,
        network: false,
      });
      this.flush();
    }
    this.flush();
    this.store.put("input", String(event.eventId), {
      id: String(event.eventId),
      stage: "completed",
      at: Date.now(),
      meetingId: config.meetingId,
    });
    const audio = event.audio
      ? await this.conversation
          .speak(meeting.summary || "受付しました。")
          .catch(() => undefined)
      : undefined;
    this.plugins.deliver(
      config.textChannelId,
      meeting.summary || "受付しました。",
      audio,
    );
  }
  async close() {
    clearInterval(this.timer);
    this.plugins.stop();
    this.tunnels.stop();
    for (const peer of this.peers.values()) peer.terminate();
    this.wss.close();
    this.preview.close();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    this.store.close();
  }
}
