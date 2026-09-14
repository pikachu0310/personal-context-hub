import { createServer, request } from "node:http";
import { randomBytes } from "node:crypto";

// Each revision gets a separate browser origin. Generated scripts cannot read
// Studio's sessionStorage or authenticated API, and old revisions lose access.
export function createPreviewRelay({
  host = "127.0.0.1",
  publicHost = "127.0.0.1",
} = {}) {
  if (!/^[a-zA-Z0-9.-]+$/.test(publicHost))
    throw new Error("Preview publicHost must be a hostname or IPv4 address");
  const entries = new Map();
  let closed = false;
  const stop = (entry) =>
    new Promise((resolve) => {
      entry.server.close(resolve);
      entry.server.closeAllConnections();
    });
  return {
    async expose(task) {
      const preview = task.preview;
      const current = () =>
        !closed &&
        task.preview === preview &&
        preview?.state === "available" &&
        preview.runRevision === task.runRevision &&
        preview.specRevision === (task.specRevision ?? 1);
      for (const [key, entry] of entries)
        if (entry.taskId === task.id && entry.preview !== preview) {
          entries.delete(key);
          await stop(entry);
        }
      if (!current() || !preview?.url) {
        for (const [key, entry] of entries)
          if (entry.taskId === task.id) {
            entries.delete(key);
            await stop(entry);
          }
        return;
      }
      const key = `${task.id}:${preview.runRevision}:${preview.specRevision}`;
      if (entries.has(key)) return;
      const upstream = new URL(preview.url);
      if (
        upstream.protocol !== "http:" ||
        upstream.hostname !== "127.0.0.1" ||
        upstream.username ||
        upstream.password
      )
        throw new Error(
          "Preview relay only accepts managed local HTTP previews",
        );
      const capability = randomBytes(24).toString("base64url");
      const cookie = `idd_preview_${randomBytes(8).toString("hex")}`;
      let authority;
      const server = createServer((req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Content-Type-Options", "nosniff");
        if (req.headers.host !== authority || !current()) {
          res
            .writeHead(410)
            .end(
              "この成果は更新・停止されました。共有スタジオで最新版を開いてください。",
            );
          return;
        }
        const url = new URL(req.url, `http://${authority}`);
        if (url.searchParams.get("preview") === capability) {
          url.searchParams.delete("preview");
          res.setHeader(
            "Set-Cookie",
            `${cookie}=${capability}; HttpOnly; SameSite=Strict; Path=/; Max-Age=14400`,
          );
          res.writeHead(303, { Location: url.pathname + url.search }).end();
          return;
        }
        if (
          !(req.headers.cookie ?? "")
            .split(/;\s*/)
            .includes(`${cookie}=${capability}`)
        ) {
          res
            .writeHead(403)
            .end("共有スタジオからプレビューを開いてください。");
          return;
        }
        if (!["GET", "HEAD", "POST"].includes(req.method)) {
          res.writeHead(405).end();
          return;
        }
        if (
          req.headers.origin &&
          req.headers.origin !== `http://${authority}`
        ) {
          res.writeHead(403).end();
          return;
        }
        const headers = { ...req.headers, host: upstream.host };
        delete headers.authorization;
        delete headers.cookie;
        delete headers.origin;
        const target = new URL(upstream);
        target.pathname = url.pathname;
        target.search = url.search;
        const proxied = request(
          target,
          { method: req.method, headers, timeout: 20000 },
          (response) => {
            const resultHeaders = {
              ...response.headers,
              "cache-control": "no-store",
              "referrer-policy": "no-referrer",
            };
            delete resultHeaders["set-cookie"];
            // This is always on a distinct, sandboxed origin from Studio.
            delete resultHeaders["x-frame-options"];
            if (resultHeaders.location?.startsWith(upstream.origin))
              resultHeaders.location =
                resultHeaders.location.slice(upstream.origin.length) || "/";
            res.writeHead(response.statusCode, resultHeaders);
            response.pipe(res);
          },
        );
        proxied.on("error", () => {
          if (!res.headersSent) res.writeHead(502);
          res.end(
            "プレビューに接続できません。スタジオで状態を確認してください。",
          );
        });
        proxied.on("timeout", () => proxied.destroy());
        let size = 0;
        req.on("data", (chunk) => {
          size += chunk.length;
          if (size > 1048576) {
            proxied.destroy();
            req.destroy();
          }
        });
        req.on("aborted", () => proxied.destroy());
        req.pipe(proxied);
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, host, resolve);
      });
      authority = `${publicHost}:${server.address().port}`;
      entries.set(key, { server, preview, taskId: task.id });
      preview.sharedUrl = `http://${authority}/?preview=${capability}`;
      preview.reachability = "participant-check-pending";
    },
    async close() {
      closed = true;
      await Promise.all([...entries.values()].map(stop));
      entries.clear();
    },
  };
}
