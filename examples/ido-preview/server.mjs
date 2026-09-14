import { createServer } from "node:http";
import { WebSocketServer } from "ws";
// Run with Node 24 in an app that has ws installed, then register this port in IDO Client.
const server = createServer(async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.method === "POST") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.end('<p>Form received.</p><a href="./">Back</a>');
    return;
  }
  res.end(
    `<!doctype html><html lang="ja"><meta charset="utf-8"><title>IDO Preview</title><h1>Shared workspace</h1><form method="post" action="./"><label>Message <input name="message" value="Hello team"></label><button>Submit</button></form><p id="status">Connecting…</p><script>const url=new URL(location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';const socket=new WebSocket(url);socket.onopen=()=>socket.send('Interactive preview connected');socket.onmessage=event=>document.getElementById('status').textContent=event.data;</script></html>`,
  );
});
const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => ws.on("message", (data) => ws.send(data)));
server.listen(5173, "127.0.0.1", () =>
  console.log("Preview on http://127.0.0.1:5173"),
);
