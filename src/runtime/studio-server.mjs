import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, sep, extname } from "node:path";
import { StudioError } from "../adapters/browser/controller.mjs";

const secret = () => randomBytes(32).toString("base64url");
const equal = (a, b) =>
  typeof a === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
async function body(req) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new StudioError(415, "JSONで送信してください。");
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 24000) throw new StudioError(413, "入力が長すぎます。");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new StudioError(400, "入力形式を読み取れません。");
  }
}

// A same-origin API with explicit participant sessions. Invitation codes never
// enter query strings, logs, cookies, generated workspaces or preview origins.
export async function startStudioServer({
  rooms,
  port = 4311,
  host = "127.0.0.1",
  publicOrigin,
  operatorCode = secret(),
  viewerCode = secret(),
  directory = fileURLToPath(new URL("../../ui/dist/", import.meta.url)),
} = {}) {
  if (!(rooms instanceof Map) || !rooms.size)
    throw new Error("Studio needs at least one room");
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Invalid Studio port");
  if (host !== "127.0.0.1" && !publicOrigin)
    throw new Error("A shared Studio requires its explicit public origin");
  for (const code of [operatorCode, viewerCode])
    if (typeof code !== "string" || code.length < 32)
      throw new Error("Studio codes need at least 32 characters");
  if (equal(operatorCode, viewerCode))
    throw new Error("Operator and viewer codes must differ");
  const sessions = new Map();
  const attempts = new Map();
  let origin;
  const send = (res, status, data) =>
    res
      .writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
      .end(JSON.stringify(data));
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src http: https:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      if (
        req.headers.host !== new URL(origin).host ||
        (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers["sec-fetch-site"] &&
          !["same-origin", "none"].includes(req.headers["sec-fetch-site"]))
      )
        throw new StudioError(403, "この接続元は許可されていません。");
      const url = new URL(req.url, origin);
      if (url.pathname === "/api/studio/login" && req.method === "POST") {
        const ip = req.socket.remoteAddress;
        const bucket = attempts.get(ip) ?? { count: 0, at: Date.now() };
        if (Date.now() - bucket.at > 60000) {
          bucket.count = 0;
          bucket.at = Date.now();
        }
        attempts.set(ip, bucket);
        if (++bucket.count > 15)
          throw new StudioError(429, "少し待ってから接続してください。");
        const input = await body(req);
        const role = equal(input.code, operatorCode)
          ? "operator"
          : equal(input.code, viewerCode)
            ? "viewer"
            : undefined;
        if (!role) throw new StudioError(401, "接続コードを確認してください。");
        for (const [key, session] of sessions)
          if (session.expiresAt < Date.now()) sessions.delete(key);
        if (sessions.size >= 100)
          throw new StudioError(503, "接続人数の上限に達しています。");
        const token = secret();
        const actor = {
          id: `browser:${randomUUID()}`,
          name:
            String(input.name ?? "参加者")
              .replace(/[\p{Cc}\p{Cf}]/gu, "")
              .slice(0, 40) || "参加者",
          role,
        };
        sessions.set(token, { actor, expiresAt: Date.now() + 12 * 3600000 });
        return send(res, 200, { token, actor });
      }
      if (url.pathname.startsWith("/api/")) {
        const token = req.headers.authorization?.replace(/^Bearer /, "");
        const session = sessions.get(token);
        if (!session || session.expiresAt < Date.now())
          throw new StudioError(401, "接続コードでもう一度接続してください。");
        if (url.pathname === "/api/studio/rooms" && req.method === "GET")
          return send(res, 200, {
            actor: session.actor,
            rooms: [...rooms].map(([id, room]) => ({
              id,
              name: room.name,
              description: room.description ?? "",
            })),
          });
        if (url.pathname === "/api/studio/logout" && req.method === "POST") {
          sessions.delete(token);
          return send(res, 200, { ok: true });
        }
        if (url.pathname === "/api/studio/invites" && req.method === "GET")
          return send(res, 200, {
            viewer: `${origin}/studio#code=${encodeURIComponent(viewerCode)}`,
            ...(session.actor.role === "operator"
              ? {
                  operator: `${origin}/studio#code=${encodeURIComponent(operatorCode)}`,
                }
              : {}),
          });
        const match = url.pathname.match(
          /^\/api\/studio\/rooms\/([a-zA-Z0-9_-]+)\/(snapshot|commands|artifacts|files)$/,
        );
        const room = match && rooms.get(match[1]);
        if (!room) throw new StudioError(404, "部屋が見つかりません。");
        if (match[2] === "snapshot" && req.method === "GET")
          return send(res, 200, {
            ...room.controller.snapshot(),
            actor: session.actor,
          });
        if (["artifacts", "files"].includes(match[2]) && req.method === "GET") {
          const fileId = url.searchParams.get("fileId");
          if (match[2] === "files" && !/^[a-f0-9]{24}$/.test(fileId ?? ""))
            throw new StudioError(
              400,
              "取得する成果ファイルを選んでください。",
            );
          const artifact = await room.controller.artifacts(
            url.searchParams.get("taskId"),
            Number(url.searchParams.get("runRevision")),
            match[2] === "files" ? fileId : undefined,
          );
          if (match[2] === "artifacts") return send(res, 200, artifact);
          res
            .writeHead(200, {
              "Content-Type": "application/octet-stream",
              "Content-Disposition": `attachment; filename="result"; filename*=UTF-8''${encodeURIComponent(artifact.name).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16)}`)}`,
              "Content-Length": artifact.data.length,
              "Content-Security-Policy": "default-src 'none'; sandbox",
            })
            .end(artifact.data);
          return;
        }
        if (match[2] === "commands" && req.method === "POST")
          return send(
            res,
            200,
            await room.controller.command(await body(req), session.actor),
          );
        throw new StudioError(405, "この操作は使えません。");
      }
      if (req.method !== "GET")
        throw new StudioError(405, "この操作は使えません。");
      if (url.pathname === "/") {
        res.writeHead(302, { Location: "/studio" }).end();
        return;
      }
      const file = ["/studio", "/stage"].includes(url.pathname)
        ? "index.html"
        : `.${decodeURIComponent(url.pathname)}`;
      const path = resolve(directory, file);
      if (!path.startsWith(resolve(directory) + sep))
        throw new StudioError(403, "このファイルは開けません。");
      const data = await readFile(path);
      res
        .writeHead(200, {
          "Content-Type":
            {
              ".html": "text/html; charset=utf-8",
              ".js": "text/javascript",
              ".css": "text/css",
              ".svg": "image/svg+xml",
            }[extname(path)] ?? "application/octet-stream",
        })
        .end(data);
    } catch (error) {
      send(res, error.status ?? (error.code === "ENOENT" ? 404 : 500), {
        error:
          error instanceof StudioError
            ? error.message
            : "処理を完了できませんでした。接続とエンジンの状態を確認してください。",
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  try {
    origin = publicOrigin
      ? new URL(publicOrigin).origin
      : `http://127.0.0.1:${server.address().port}`;
    if (!/^https?:/.test(origin))
      throw new Error("Studio origin must be HTTP(S)");
  } catch (error) {
    server.close();
    throw error;
  }
  return {
    url: `${origin}/studio`,
    operatorCode,
    viewerCode,
    invitation(role = "operator") {
      return `${origin}/studio#code=${encodeURIComponent(role === "viewer" ? viewerCode : operatorCode)}`;
    },
    async close() {
      sessions.clear();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
