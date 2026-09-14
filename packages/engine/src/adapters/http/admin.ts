import { createPublicKey, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { id, text } from "../../../../common/src/contracts/protocol.js";
import {
  asset,
  body,
  headers,
  HttpError,
  send,
} from "../../../../common/src/runtime/http.js";
import {
  equal,
  hash,
  passwordMatches,
  secret,
} from "../../../../common/src/runtime/platform.js";
import type { Engine } from "../../bootstrap/engine.js";
import type { Device } from "../../domain/models.js";
import { lifecycle } from "./lifecycle.js";
import { members } from "./members.js";
import { proxyPlugin } from "./plugin-proxy.js";
import { plugins } from "./plugins.js";
import { publicRoutes } from "./public.js";
import { settings } from "./settings.js";
import { tunnels } from "./tunnels.js";
type Pair = {
  id: string;
  proof: string;
  publicKey: string;
  name: string;
  expires: number;
  userId?: string;
};
export async function route(
  this: Engine,
  req: IncomingMessage,
  res: ServerResponse,
) {
  const url = new URL(req.url ?? "/", this.origin);
  if (!this.trustedHost(req))
    throw new HttpError(403, "HTTPS_PROXY_OR_LOCALHOST_REQUIRED");
  // Preview requests use a scoped capability, never the management session.
  // Opaque sandbox origins must reach the relay but cannot reach management APIs.
  if (url.pathname === "/preview" || url.pathname.startsWith("/preview/")) {
    await this.preview.http(req, res);
    return;
  }
  const requestOrigin = req.headers.origin;
  const expected =
    req.headers.host === new URL(this.origin).host
      ? this.origin
      : this.config().engineUrl;
  const pluginEntry = this.plugins.catalog.find((entry) => {
    const base = this.plugins.get(entry.id).manifest?.web?.basePath;
    return (
      base && (url.pathname === base || url.pathname.startsWith(base + "/"))
    );
  });
  const plugin = pluginEntry && this.plugins.get(pluginEntry.id);
  headers(res, plugin?.manifest?.web?.frameAncestors ?? []);
  const frameOrigins = plugin?.manifest?.web?.frameOrigins ?? [];
  if (
    requestOrigin &&
    requestOrigin !== expected &&
    !frameOrigins.includes(requestOrigin)
  )
    throw new HttpError(403, "ORIGIN_DENIED");
  if (plugin?.manifest?.web) {
    const path = url.pathname.slice(plugin.manifest.web.basePath.length) || "/";
    const publicPath = plugin.manifest.web.publicPaths.some((p) =>
      p !== "/" && p.endsWith("/") ? path.startsWith(p) : path === p,
    );
    let context: string | undefined;
    if (!publicPath) {
      const auth = this.authenticate(req);
      if (
        req.method !== "GET" &&
        !equal(String(req.headers["x-csrf-token"] ?? ""), auth.csrf)
      )
        throw new HttpError(403, "CSRF_REQUIRED");
      context = this.contexts.issue(
        plugin.id,
        auth.user.id,
        plugin.generation,
        "member",
        () => {
          try {
            return this.authenticate(req).user.id === auth.user.id;
          } catch {
            return false;
          }
        },
      );
    }
    await proxyPlugin(plugin, req, res, path + url.search, context);
    return;
  }
  if (
    url.pathname.startsWith("/plugins/") ||
    url.pathname.startsWith("/dashboard")
  )
    throw new HttpError(503, "PLUGIN_NOT_RUNNING");
  if (url.pathname === "/health") {
    send(res, 200, { ok: true, service: "ido-engine", protocol: 1 });
    return;
  }
  if (!url.pathname.startsWith("/api/admin/")) {
    if (url.pathname === "/") {
      const embedded = [...this.plugins.processes.values()].find((plugin) => {
        const launch = plugin.manifest?.web?.launch;
        return (
          launch?.query.length &&
          launch.query.every((key) => url.searchParams.has(key))
        );
      })?.manifest?.web;
      headers(res, embedded?.frameAncestors ?? []);
      res.writeHead(302, {
        Location: embedded
          ? embedded.basePath + embedded.launch!.path + url.search
          : "/admin",
      });
      res.end();
      return;
    }
    if (!url.pathname.startsWith("/admin"))
      throw new HttpError(404, "NOT_FOUND");
    await asset(req, res, this.ui, url.pathname.slice(6) || "/");
    return;
  }
  if (url.pathname === "/api/admin/login" && req.method === "POST") {
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
  if (url.pathname === "/api/admin/pair/request" && req.method === "POST") {
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
      url: `${expected}/admin/pair/${pair.id}`,
    });
    return;
  }
  if (url.pathname === "/api/admin/pair/poll" && req.method === "POST") {
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
    if (url.pathname === "/api/admin/logout") {
      if (!equal(String(req.headers["x-csrf-token"] ?? ""), auth.csrf))
        throw new HttpError(403, "CSRF_REQUIRED");
    } else this.mutate(req, auth);
  }
  if (url.pathname === "/api/admin/session" && req.method === "GET") {
    send(res, 200, { user: auth.user, csrf: auth.csrf });
    return;
  }
  if (url.pathname === "/api/admin/state" && req.method === "GET") {
    send(res, 200, {
      mode: "engine",
      user: auth.user,
      csrf: auth.csrf,
      clients: this.store.list<Device>("device").map(({ publicKey, ...d }) => ({
        ...d,
        connected: this.ready.has(d.id),
      })),
      plugins: this.plugins
        .state()
        .map((plugin) => ({ ...plugin, config: admin ? plugin.config : {} })),
      tunnels: {
        status: this.tunnels.status,
        installed: this.store.list("tunnel"),
        busy: this.tunnels.busy || this.tunnels.starting,
        error: this.tunnels.error,
      },
      config: admin ? this.config() : {},
      users: admin ? this.store.users() : [],
      audit: admin ? this.store.events() : [],
      diagnostics: admin ? this.store.diagnostics() : [],
      secrets: admin
        ? {
            openai: !!(await this.credentials.get("openai")),
          }
        : {},
    });
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/api/admin/pair/")) {
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
  for (const handler of [
    members,
    settings,
    plugins,
    publicRoutes,
    tunnels,
    lifecycle,
  ])
    if (await handler.call(this, req, res, url, input, auth)) return;
  switch (url.pathname) {
    case "/api/admin/logout":
      this.store.db
        .prepare("DELETE FROM sessions WHERE token=?")
        .run(hash(auth.token));
      res.setHeader("Set-Cookie", "ido_session=; Path=/; HttpOnly; Max-Age=0");
      break;
    case "/api/admin/pair/approve": {
      const pair = this.store.get<Pair>("pair", id(input.id));
      if (!pair || pair.userId || pair.expires < Date.now())
        throw new HttpError(410, "PAIR_EXPIRED");
      pair.userId = auth.user.id;
      this.store.put("pair", pair.id, pair);
      this.store.audit(auth.user.id, "device.approve", pair.id);
      break;
    }
    default:
      throw new HttpError(404, "NOT_FOUND");
  }
  send(res, 200, { ok: true });
}
