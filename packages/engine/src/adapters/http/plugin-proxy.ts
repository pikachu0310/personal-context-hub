import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { HttpError } from "@ido/common/runtime/http";
import type { PluginProcess } from "../plugins/process.js";
export async function proxyPlugin(
  plugin: PluginProcess,
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  context?: string,
) {
  if (!plugin.port || !plugin.child?.connected)
    throw new HttpError(503, "PLUGIN_NOT_RUNNING");
  const generation = plugin.generation;
  await new Promise<void>((resolve, reject) => {
    const headers: Record<string, string> = {
      "content-type": String(req.headers["content-type"] ?? "application/json"),
    };
    if (context) headers["x-ido-context"] = context;
    if (req.headers.authorization)
      headers.authorization = req.headers.authorization;
    const upstream = httpRequest(
      {
        hostname: "127.0.0.1",
        port: plugin.port,
        method: req.method,
        path,
        headers,
      },
      (response) => {
        if (plugin.generation !== generation) {
          response.destroy();
          reject(new HttpError(503, "PLUGIN_STOPPED"));
          return;
        }
        res.statusCode = response.statusCode ?? 502;
        for (const header of ["content-type", "location", "cache-control"])
          if (response.headers[header])
            res.setHeader(header, response.headers[header]!);
        response.on("error", reject);
        response.pipe(res);
        response.once("end", resolve);
      },
    );
    upstream.setTimeout(65000, () =>
      upstream.destroy(new Error("PLUGIN_TIMEOUT")),
    );
    upstream.once("error", () =>
      reject(new HttpError(502, "PLUGIN_UNAVAILABLE")),
    );
    req.once("aborted", () => upstream.destroy());
    res.once("close", () => {
      if (!res.writableEnded) upstream.destroy();
    });
    req.pipe(upstream);
  });
}
