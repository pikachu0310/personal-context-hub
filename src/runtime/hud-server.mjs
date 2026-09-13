import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";
import { randomUUID } from "node:crypto";

const stages = new Set([
  "AUDIO",
  "STT",
  "ASSEMBLE",
  "OBSERVE",
  "IMMEDIATE",
  "QUEUE",
  "EXECUTE",
  "DELIVER",
  "TTS",
  "PLAYBACK",
]);
const statuses = new Set([
  "waiting",
  "running",
  "completed",
  "failed",
  "interrupted",
  "skipped",
]);
const clean = (value) =>
  typeof value === "string"
    ? value
        .slice(0, 2000)
        .replace(
          /(?:Bearer\s+\S+|sk-[A-Za-z0-9_-]{16,}|mfa\.[A-Za-z0-9_-]+)/gi,
          "[redacted]",
        )
    : undefined;
export function createHudStore() {
  const sessionId = randomUUID();
  let sequence = 0;
  const events = [],
    active = new Map(),
    subscribers = new Set();
  return {
    publish(input) {
      if (!stages.has(input?.stage) || !statuses.has(input?.status)) return;
      const event = {
        sequence: ++sequence,
        sessionId,
        at: Number.isFinite(input.at) ? input.at : Date.now(),
        stage: input.stage,
        status: input.status,
      };
      for (const key of [
        "spanId",
        "taskId",
        "runId",
        "parentId",
        "text",
        "speaker",
        "title",
        "tool",
        "query",
        "summary",
        "reason",
      ]) {
        const value = clean(input[key]);
        if (value !== undefined) event[key] = value;
      }
      event.inputIds = Array.isArray(input.inputIds)
        ? input.inputIds.slice(0, 100).map(clean).filter(Boolean)
        : [];
      const prior = active.get(event.spanId);
      event.startedAt = prior?.startedAt ?? event.at;
      if (
        event.spanId === `task-${event.taskId}` &&
        prior?.status !== event.status &&
        ["waiting", "running"].includes(event.status)
      )
        event.startedAt = event.at;
      if (event.spanId && ["waiting", "running"].includes(event.status)) {
        active.set(event.spanId, event);
        if (active.size > 1000) active.delete(active.keys().next().value);
      } else active.delete(event.spanId);
      events.push(event);
      if (events.length > 1000) events.shift();
      for (const listener of subscribers) {
        try {
          listener(event);
        } catch {
          /* detached consumer */
        }
      }
    },
    snapshot: () => ({
      sessionId,
      sequence,
      events: structuredClone(events),
      active: structuredClone([...active.values()]),
    }),
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
}
export async function startHudServer({
  port = 4310,
  store = createHudStore(),
  directory = fileURLToPath(new URL("../../ui/dist/", import.meta.url)),
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("HUD port must be 0..65535");
  const clients = new Set();
  const server = createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'",
    );
    if (
      req.headers.host !== host ||
      (req.headers.origin && req.headers.origin !== `http://${host}`) ||
      (req.headers["sec-fetch-site"] &&
        !["same-origin", "none"].includes(req.headers["sec-fetch-site"]))
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    const url = new URL(req.url, `http://${host}`);
    if (url.pathname === "/api/snapshot") {
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify(store.snapshot()));
      return;
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      clients.add(res);
      const send = (event) => {
        if (
          !res.write(
            `id: ${event.sequence}\nevent: observation\ndata: ${JSON.stringify(event)}\n\n`,
          )
        )
          res.destroy();
      };
      const after = Number(
        req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0,
      );
      const snapshot = store.snapshot();
      if (
        !Number.isSafeInteger(after) ||
        after > snapshot.sequence ||
        after < (snapshot.events[0]?.sequence ?? 1) - 1 ||
        url.searchParams.get("session") !== snapshot.sessionId
      )
        res.write("event: reset\ndata: {}\n\n");
      else
        for (const event of snapshot.events)
          if (event.sequence > after) send(event);
      const unsubscribe = store.subscribe(send);
      const heartbeat = setInterval(() => {
        if (!res.write("event: heartbeat\ndata: {}\n\n")) res.destroy();
      }, 15000);
      res.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
        clients.delete(res);
      });
      return;
    }
    try {
      const path = resolve(
        directory,
        url.pathname === "/"
          ? "index.html"
          : `.${decodeURIComponent(url.pathname)}`,
      );
      if (!path.startsWith(resolve(directory) + sep)) {
        res.writeHead(403).end();
        return;
      }
      const body = await readFile(path);
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
        .end(body);
    } catch {
      res.writeHead(404).end("HUD assets not found. Run npm run hud:build.");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    store,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve) => {
        for (const client of clients) client.destroy();
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}
