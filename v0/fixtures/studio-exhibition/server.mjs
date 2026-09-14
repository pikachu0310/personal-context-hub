import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
const root = await realpath(process.cwd());
const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
};
const server = createServer(async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    const url = new URL(req.url, "http://127.0.0.1");
    const path = await realpath(
      resolve(
        root,
        url.pathname === "/"
          ? "index.html"
          : `.${decodeURIComponent(url.pathname)}`,
      ),
    );
    if (!path.startsWith(root + sep) || !types[extname(path)]) {
      res.writeHead(404).end();
      return;
    }
    res
      .writeHead(200, {
        "Content-Type": types[extname(path)],
        "Cache-Control": "no-store",
      })
      .end(await readFile(path));
  } catch {
    res.writeHead(404).end("Not found");
  }
});
server.listen(Number(process.argv[2]), "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    server.close();
    server.closeAllConnections();
  });
