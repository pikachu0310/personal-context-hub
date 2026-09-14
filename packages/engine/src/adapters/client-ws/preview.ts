import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { Command, Preview, Task } from "@ido/common/contracts/protocol";
import { send } from "@ido/common/runtime/http";
import { secret } from "@ido/common/runtime/platform";
import type { Repository } from "../../ports/repository.js";

export class PreviewRelay {
  registrations = new Map<string, Preview & { deviceId: string }>();
  tickets = new Map<
    string,
    { previewId: string; userId: string; expires: number }
  >();
  pending = new Map<
    string,
    {
      deviceId: string;
      resolve: (data: Command) => void;
      timer: NodeJS.Timeout;
    }
  >();
  sockets = new Map<string, { deviceId: string; socket: WebSocket }>();
  server = createServer((req, res) => {
    void this.http(req, res).catch(() =>
      send(res, 502, { error: "PREVIEW_UNAVAILABLE" }),
    );
  });
  wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
  });
  constructor(
    readonly store: Repository,
    readonly connection: (id: string) => WebSocket | undefined,
    readonly frameAncestors: () => string[] = () => [],
  ) {
    this.server.on("upgrade", (req, socket, head) => {
      const context = this.authorize(req);
      if (!context) {
        socket.destroy();
        return;
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const requestId = randomUUID();
        this.sockets.set(requestId, {
          deviceId: context.preview.deviceId,
          socket: ws,
        });
        this.send(context.preview.deviceId, {
          v: 1,
          type: "preview.ws.open",
          requestId,
          previewId: context.preview.id,
          path: context.path,
          basePath: context.basePath,
        });
        ws.on("message", (data, binary) => {
          if (data.toString().length > 1024 * 1024) {
            ws.close(1009);
            return;
          }
          this.send(context.preview.deviceId, {
            v: 1,
            type: "preview.ws.data",
            requestId,
            data: Buffer.from(data as Buffer).toString("base64"),
            binary,
          });
        });
        ws.on("close", () => {
          this.sockets.delete(requestId);
          this.send(context.preview.deviceId, {
            v: 1,
            type: "preview.ws.close",
            requestId,
          });
        });
      });
    });
  }
  send(deviceId: string, data: Command) {
    const ws = this.connection(deviceId);
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  }
  register(deviceId: string, data: Command) {
    const task = this.store.get<Task>("task", String(data.taskId));
    if (
      !task ||
      task.clientId !== deviceId ||
      task.runId !== data.runId ||
      task.revision !== data.revision ||
      typeof data.previewId !== "string" ||
      !/^[-\w]{1,100}$/.test(data.previewId)
    )
      return;
    const preview = {
      id: data.previewId,
      taskId: task.id,
      runId: task.runId,
      revision: task.revision,
      expiresAt: Date.now() + 3600000,
    };
    this.registrations.set(preview.id, { ...preview, deviceId });
    task.preview = preview;
    this.store.put("task", task.id, task);
  }
  ticket(taskId: string, userId: string) {
    const task = this.store.get<Task>("task", taskId),
      preview = task?.preview && this.registrations.get(task.preview.id);
    if (
      !preview ||
      !this.connection(preview.deviceId) ||
      preview.expiresAt < Date.now()
    )
      throw new Error("PREVIEW_OFFLINE");
    for (const [key, value] of this.tickets)
      if (value.expires < Date.now()) this.tickets.delete(key);
    const token = secret();
    this.tickets.set(token, {
      previewId: preview.id,
      userId,
      expires: Math.min(preview.expiresAt, Date.now() + 15 * 60000),
    });
    return `/preview/p/${token}/`;
  }
  authorize(req: IncomingMessage) {
    const url = new URL(req.url ?? "/", "http://preview.local");
    const match = /^\/preview\/p\/([\w-]+)\/(.*)$/.exec(url.pathname);
    if (!match) return;
    const ticket = this.tickets.get(match[1]);
    const preview = ticket && this.registrations.get(ticket.previewId);
    const task = preview && this.store.get<Task>("task", preview.taskId);
    if (
      !ticket ||
      ticket.expires < Date.now() ||
      !this.store.user(ticket.userId) ||
      !preview ||
      preview.expiresAt < Date.now() ||
      !task ||
      task.revision !== preview.revision ||
      task.runId !== preview.runId ||
      !this.connection(preview.deviceId) ||
      ["cancelled", "interrupted"].includes(task.state)
    )
      return;
    // A request can only address this registered preview. Absolute URL and traversal syntax are rejected.
    const path = "/" + match[2] + url.search;
    if (/%2e|%2f|%5c|\\/i.test(match[2]) || match[2].split("/").includes(".."))
      return;
    return { preview, path, basePath: `/preview/p/${match[1]}/` };
  }
  async http(req: IncomingMessage, res: ServerResponse) {
    res.setHeader(
      "Content-Security-Policy",
      `sandbox allow-scripts allow-forms; default-src 'none'; frame-ancestors 'self' ${this.frameAncestors().join(" ")}`,
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const context = this.authorize(req);
    if (!context) {
      send(res, 410, { error: "PREVIEW_EXPIRED_OR_OFFLINE" });
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    if (this.pending.size >= 100) {
      send(res, 429, { error: "PREVIEW_BUSY" });
      return;
    }
    if (
      !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(
        req.method ?? "",
      )
    ) {
      send(res, 405, {});
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        send(res, 413, {});
        return;
      }
      chunks.push(chunk);
    }
    const requestId = randomUUID();
    const response = await new Promise<Command>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("PREVIEW_TIMEOUT"));
      }, 15000);
      this.pending.set(requestId, {
        deviceId: context.preview.deviceId,
        resolve,
        timer,
      });
      this.send(context.preview.deviceId, {
        v: 1,
        type: "preview.http",
        requestId,
        previewId: context.preview.id,
        path: context.path,
        basePath: context.basePath,
        method: req.method,
        headers: {
          "content-type": req.headers["content-type"] ?? "",
          accept: req.headers.accept ?? "*/*",
        },
        body: Buffer.concat(chunks).toString("base64"),
      });
    });
    res.setHeader(
      "Content-Security-Policy",
      `sandbox allow-scripts allow-forms; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' wss: ws:; object-src 'none'; base-uri 'none'; frame-src 'none'; worker-src 'none'; form-action 'self'; frame-ancestors 'self' ${this.frameAncestors().join(" ")}`,
    );
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    const responseHeaders = response.headers as
      Record<string, string> | undefined;
    for (const key of ["content-type", "content-language"])
      if (responseHeaders?.[key]) res.setHeader(key, responseHeaders[key]);
    const location = responseHeaders?.location;
    if (
      location?.startsWith("/") &&
      !location.startsWith("//") &&
      !/%2e|%2f|%5c|\\/i.test(location) &&
      !location.split(/[/?#]/).includes("..")
    )
      res.setHeader("location", context.basePath + location.slice(1));
    res.statusCode = Math.max(
      200,
      Math.min(599, Number(response.status) || 502),
    );
    res.end(
      req.method === "HEAD"
        ? undefined
        : Buffer.from(String(response.body ?? ""), "base64"),
    );
  }
  receive(deviceId: string, data: Command) {
    const requestId = String(data.requestId);
    const pending = this.pending.get(requestId);
    if (data.type === "preview.http.result" && pending?.deviceId === deviceId) {
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      pending.resolve(data);
    }
    const stream = this.sockets.get(requestId);
    if (stream?.deviceId === deviceId) {
      if (data.type === "preview.ws.data")
        stream.socket.send(Buffer.from(String(data.data), "base64"), {
          binary: data.binary === true,
        });
      else if (data.type === "preview.ws.close") stream.socket.close();
    }
  }
  disconnected(deviceId: string) {
    for (const [id, value] of this.registrations)
      if (value.deviceId === deviceId) this.registrations.delete(id);
    for (const [id, value] of this.sockets)
      if (value.deviceId === deviceId) {
        value.socket.close(1012);
        this.sockets.delete(id);
      }
  }
  close() {
    for (const value of this.pending.values()) clearTimeout(value.timer);
    for (const value of this.sockets.values()) value.socket.close();
    this.wss.close();
    this.server.close();
  }
}
