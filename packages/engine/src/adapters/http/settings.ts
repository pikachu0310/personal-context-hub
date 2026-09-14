import type { IncomingMessage, ServerResponse } from "node:http";
import { text } from "@ido/common/contracts/protocol";
import { send } from "@ido/common/runtime/http";
import type { Engine } from "../../bootstrap/engine.js";
import type { Auth } from "./auth.js";
export async function settings(
  this: Engine,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  input: Record<string, any>,
  auth: Auth,
) {
  const admin = auth.user.role === "admin";
  switch (url.pathname) {
    case "/api/admin/settings": {
      this.mutate(req, auth, true);
      if (input.openai)
        await this.credentials.set("openai", text(input.openai, 4000));
      this.store.audit(auth.user.id, "settings.update", "configuration");
      break;
    }
    default:
      return false;
  }
  send(res, 200, { ok: true });
  return true;
}
