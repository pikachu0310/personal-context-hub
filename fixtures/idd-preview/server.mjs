import { createServer } from "node:http";
import { readFile } from "node:fs/promises";

const port = Number(process.argv[2] ?? process.env.PORT);
const server = createServer(async (_request, response) => {
  try {
    const size = JSON.parse(
      await readFile(new URL("./ui.json", import.meta.url), "utf8"),
    );
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="ja"><meta charset="utf-8"><title>IDD preview fixture</title>
<style>body{font:18px system-ui;background:#f4f1e9;color:#152d25;padding:48px}button{width:${Number(size.width)}px;height:${Number(size.height)}px;background:#225d49;color:white;border:0;border-radius:8px;font:inherit}h1{font-size:32px}</style>
<main><h1>会話から、試せる版へ</h1><p>検証用の小さなUIです。</p><button type="button">試す</button><p role="status">未操作</p></main>
<script>let count=0;document.querySelector('button').onclick=()=>{document.querySelector('[role="status"]').textContent='操作 '+(++count)+' 回';};</script></html>`);
  } catch {
    response.writeHead(500).end("Preview configuration unavailable");
  }
});
server.listen(port, "127.0.0.1");
const stop = () => server.close(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
