import type { IncomingMessage, ServerResponse } from "node:http";
import { asset, body, HttpError, send } from "@ido/common/runtime/http";
import type { Rpc } from "@ido/common/runtime/rpc";
export async function route(
  req: IncomingMessage,
  res: ServerResponse,
  rpc: Rpc,
  ui: string,
) {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/api/")) {
    await asset(req, res, ui, url.pathname);
    return;
  }
  const operation = url.pathname.slice(5);
  if (
    !(req.method === "GET" && operation === "state") &&
    !(
      req.method === "POST" &&
      [
        "projects",
        "project/invite",
        "project/delete",
        "task/delete",
        "meetings",
        "messages",
        "tasks",
        "task/control",
        "artifact",
        "preview",
        "conversation/state",
        "conversation/log",
        "conversation/control",
      ].includes(operation)
    )
  )
    throw new HttpError(404, "NOT_FOUND");
  const context = req.headers["x-ido-context"];
  if (typeof context !== "string") throw new HttpError(401, "LOGIN_REQUIRED");
  send(
    res,
    200,
    await rpc.request(
      operation,
      req.method === "GET" ? {} : await body(req),
      context,
    ),
  );
}
