import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  asset,
  body,
  HttpError,
  RateLimit,
  send,
} from "../../../common/src/runtime/http.js";
import type { Rpc } from "../../../common/src/runtime/rpc.js";
import { DiscordAuth } from "../auth/sessions.js";
export class DiscordWeb {
  readonly auth: DiscordAuth;
  readonly limit = new RateLimit(20, 60000);
  readonly server = createServer(
    (req, res) =>
      void this.route(req, res).catch((error) => {
        const code =
          error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
            ? error.message
            : "REQUEST_FAILED";
        send(
          res,
          error instanceof HttpError
            ? error.status
            : code === "LOGIN_REQUIRED"
              ? 401
              : 400,
          { error: code },
        );
      }),
  );
  constructor(
    readonly config: () => Record<string, string>,
    readonly rpc: () => Rpc,
  ) {
    this.auth = new DiscordAuth(config, rpc);
  }
  async route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/callback" && req.method === "GET") {
      await this.auth.callback(
        url.searchParams.get("state") ?? "",
        url.searchParams.get("code") ?? "",
      );
      res.writeHead(302, { Location: "/admin" });
      res.end();
      return;
    }
    const context =
      typeof req.headers["x-ido-context"] === "string"
        ? req.headers["x-ido-context"]
        : undefined;
    if (url.pathname === "/link" && req.method === "POST") {
      if (!context) throw new HttpError(401, "LOGIN_REQUIRED");
      const info = await this.rpc().request<{ origin: string }>(
        "identity.me",
        {},
        context,
      );
      send(res, 200, { url: this.auth.start(context, info.origin) });
      return;
    }
    if (url.pathname === "/api/activity/config" && req.method === "GET") {
      send(res, 200, { appId: this.config().appId });
      return;
    }
    if (url.pathname === "/api/activity/auth" && req.method === "POST") {
      this.limit.take("oauth");
      send(res, 200, await this.auth.activity(String((await body(req)).code)));
      return;
    }
    if (url.pathname.startsWith("/api/activity/")) {
      const operation = (
        {
          state: "state",
          message: "messages",
          control: "task/control",
          preview: "preview",
        } as Record<string, string>
      )[url.pathname.slice(14)];
      if (!operation || req.method !== (operation === "state" ? "GET" : "POST"))
        throw new HttpError(404, "NOT_FOUND");
      const token = (req.headers.authorization ?? "").replace(/^Bearer /, "");
      send(
        res,
        200,
        await this.rpc().request(
          operation,
          req.method === "GET" ? {} : await body(req),
          token,
        ),
      );
      return;
    }
    if (url.pathname === "/channels" && req.method === "POST") {
      const user = await this.rpc().request<{ role: string }>(
        "identity.me",
        {},
        context,
      );
      if (user.role !== "admin") throw new HttpError(403, "PERMISSION_DENIED");
      const response = await fetch(
        `https://discord.com/api/v10/guilds/${this.config().guildId}/channels`,
        {
          headers: { Authorization: `Bot ${this.config().botToken}` },
          signal: AbortSignal.timeout(15000),
        },
      );
      if (!response.ok) throw new Error("DISCORD_DIAGNOSIS_FAILED");
      send(res, 200, {
        channels: (
          (await response.json()) as Array<{
            id: string;
            name: string;
            type: number;
          }>
        ).map(({ id, name, type }) => ({ id, name, type })),
      });
      return;
    }
    await asset(
      req,
      res,
      join(dirname(fileURLToPath(import.meta.url)), "ui"),
      url.pathname,
    );
  }
  async start() {
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    return address && typeof address !== "string" ? address.port : undefined;
  }
  close() {
    return new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
