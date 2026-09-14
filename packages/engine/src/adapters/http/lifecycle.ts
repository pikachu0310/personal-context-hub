import type { IncomingMessage, ServerResponse } from "node:http";
import { id, text } from "@ido/common/contracts/protocol";
import { send } from "@ido/common/runtime/http";
import type { Engine } from "../../bootstrap/engine.js";
import type { Auth } from "./auth.js";
export async function lifecycle(
  this: Engine,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  input: Record<string, any>,
  auth: Auth,
) {
  const admin = auth.user.role === "admin";
  switch (url.pathname) {
    case "/api/admin/plugins/install":
      this.mutate(req, auth, true);
      await this.plugins.install(id(input.pluginId), text(input.version, 30));
      this.store.audit(auth.user.id, "plugin.install", id(input.pluginId));
      break;
    case "/api/admin/plugins/start":
      this.mutate(req, auth, true);
      await this.plugins.start(id(input.pluginId));
      break;
    case "/api/admin/plugins/stop":
      this.mutate(req, auth, true);
      await this.plugins.get(id(input.pluginId)).stop();
      break;
    default:
      return false;
  }
  send(res, 200, { ok: true });
  return true;
}
