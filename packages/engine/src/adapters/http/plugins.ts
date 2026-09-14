import type { IncomingMessage, ServerResponse } from "node:http";
import { id } from "../../../../common/src/contracts/protocol.js";
import { send } from "../../../../common/src/runtime/http.js";
import type { Engine } from "../../bootstrap/engine.js";
import type { Auth } from "./auth.js";
export async function plugins(
  this: Engine,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  input: Record<string, any>,
  auth: Auth,
) {
  const admin = auth.user.role === "admin";
  switch (url.pathname) {
    case "/api/admin/plugins/configure": {
      this.mutate(req, auth, true);
      await this.plugins.configure(id(input.pluginId), input.config);
      break;
    }
    default:
      return false;
  }
  send(res, 200, { ok: true });
  return true;
}
