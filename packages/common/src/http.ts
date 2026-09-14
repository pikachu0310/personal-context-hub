import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { secret } from "./platform.js";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function body(req: IncomingMessage, limit = 65536): Promise<any> {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new HttpError(415, "JSON_REQUIRED");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
}
export function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(value));
}
export function headers(res: ServerResponse, activity = false) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.discordapp.com; connect-src 'self'; frame-src https: http://127.0.0.1:*; frame-ancestors ${activity ? "https://discord.com https://*.discord.com https://*.discordsays.com" : "'none'"}; base-uri 'none'; form-action 'self'`,
  );
}
export async function asset(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  pathname: string,
) {
  let path = resolve(root, "." + pathname);
  if (!path.startsWith(resolve(root) + sep)) path = resolve(root, "index.html");
  if (!extname(path)) path = resolve(root, "index.html");
  try {
    const data = await readFile(path);
    const mime: Record<string, string> = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
    };
    res.writeHead(200, {
      "Content-Type": mime[extname(path)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    send(res, 404, { error: "NOT_FOUND" });
  }
}
export class RateLimit {
  constructor(
    readonly max = 20,
    readonly window = 60000,
  ) {}
  entries = new Map<string, { count: number; until: number }>();
  take(key: string, max = this.max, window = this.window) {
    const now = Date.now();
    if (this.entries.size > 5000)
      for (const [k, v] of this.entries)
        if (v.until < now) this.entries.delete(k);
    const value = this.entries.get(key);
    if (!value || value.until < now) {
      this.entries.set(key, { count: 1, until: now + window });
      return true;
    }
    if (++value.count > max) throw new HttpError(429, "RATE_LIMITED");
    return true;
  }
}
export function localGuard(req: IncomingMessage, origin: string) {
  if (
    req.headers.host !== new URL(origin).host ||
    (req.headers.origin && req.headers.origin !== origin)
  )
    throw new HttpError(403, "ORIGIN_DENIED");
  if (
    req.headers["sec-fetch-site"] &&
    !["none", "same-origin"].includes(String(req.headers["sec-fetch-site"]))
  )
    throw new HttpError(403, "ORIGIN_DENIED");
}
export const localToken = secret;
