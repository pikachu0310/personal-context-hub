import { request } from "node:http";
import { WebSocket } from "ws";
import type { Command } from "../../common/src/protocol.js";

export class ClientPreview {
  registrations = new Map<string, { port: number; basePath: string }>();
  streams = new Map<string, WebSocket>();
  constructor(readonly emit: (message: Command) => void) {}
  register(id: string, port: number) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535)
      throw new Error("INVALID_PORT");
    this.registrations.set(id, { port, basePath: "/" });
  }
  async receive(data: Command) {
    const requestId = String(data.requestId);
    if (data.type === "preview.ws.close") {
      this.streams.get(requestId)?.close();
      this.streams.delete(requestId);
      return;
    }
    if (data.type === "preview.ws.data") {
      const stream = this.streams.get(requestId);
      const buffer = Buffer.from(String(data.data), "base64");
      if (stream?.readyState === WebSocket.OPEN)
        stream.send(buffer, { binary: data.binary === true });
      else if (stream?.readyState === WebSocket.CONNECTING)
        stream.once("open", () =>
          stream.send(buffer, { binary: data.binary === true }),
        );
      return;
    }
    const registration = this.registrations.get(String(data.previewId));
    if (!registration) return;
    const path = String(data.path),
      basePath = String(data.basePath);
    if (
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      !/^\/preview\/p\/[\w-]+\/$/.test(basePath)
    )
      return;
    const target = `http://127.0.0.1:${registration.port}${path}`;
    if (data.type === "preview.http") {
      await new Promise<void>((resolve) => {
        const incomingHeaders = data.headers as Record<string, string>;
        const upstream = request(
          target,
          {
            method: String(data.method),
            headers: {
              "content-type": incomingHeaders?.["content-type"] ?? "",
              accept: incomingHeaders?.accept ?? "*/*",
              "x-forwarded-prefix": basePath,
            },
            timeout: 10000,
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (size > 1024 * 1024) {
                upstream.destroy();
                return;
              }
              chunks.push(chunk);
            });
            res.on("end", () => {
              this.emit({
                v: 1,
                type: "preview.http.result",
                requestId,
                status: res.statusCode,
                headers: {
                  "content-type": res.headers["content-type"],
                  location: res.headers.location,
                },
                body: Buffer.concat(chunks).toString("base64"),
              });
              resolve();
            });
          },
        );
        upstream.on("timeout", () => upstream.destroy());
        upstream.on("error", () => {
          this.emit({
            v: 1,
            type: "preview.http.result",
            requestId,
            status: 502,
            body: Buffer.from("Preview server unavailable").toString("base64"),
          });
          resolve();
        });
        upstream.end(Buffer.from(String(data.body ?? ""), "base64"));
      });
    } else if (data.type === "preview.ws.open") {
      const stream = new WebSocket(target.replace(/^http:/, "ws:"), {
        maxPayload: 1024 * 1024,
        perMessageDeflate: false,
        handshakeTimeout: 10000,
      });
      this.streams.set(requestId, stream);
      stream.on("message", (data, binary) =>
        this.emit({
          v: 1,
          type: "preview.ws.data",
          requestId,
          data: Buffer.from(data as Buffer).toString("base64"),
          binary,
        }),
      );
      stream.on("error", () => stream.close());
      stream.on("close", () => {
        this.streams.delete(requestId);
        this.emit({ v: 1, type: "preview.ws.close", requestId });
      });
    }
  }
  close() {
    for (const stream of this.streams.values()) stream.close();
    this.streams.clear();
    this.registrations.clear();
  }
}
